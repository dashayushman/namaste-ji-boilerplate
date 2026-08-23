/**
 * Durable run executor — the kernel's Workflow wrapper for agent runs (AGENT-KERNEL.md).
 *
 * WHY: the original executor ran the agent loop inside `ctx.waitUntil(...)`, which Cloudflare
 * kills ~30 seconds after the response is returned. A Workflow step has no CPU problem for an
 * LLM loop (~all network wait), but the docs' "unlimited wall clock per step" does NOT hold in
 * practice: the engine kills a single step attempt at ~5 minutes of wall time (observed on
 * staging as `WorkflowInternalError: Attempt failed due to internal workflows error` + a
 * `clientDisconnected` invocation, twice, at 5:02 and 5:03 — deterministic, not an eviction).
 * So one big step wrapping the whole run guaranteed death for any run over ~5 minutes.
 *
 * Shape: the run executes as MANY small steps — the orchestrator checkpoints EVERY TURN via the
 * `stepper` this executor passes to the agent (see orchestrator.ts). Cross-turn state (STM +
 * agent-local tool state) is JSON-serializable, so:
 *   - isolate death mid-turn  → the engine retries THAT TURN; completed turns replay from
 *     storage without re-executing. Cost of a death = at most one turn re-run, not the run.
 *   - errors inside a turn    → wrapped in NonRetryableError so the engine does NOT retry them
 *     (kernel `withRetry` already handled transient provider errors; an engine retry would
 *     re-spend the turn's LLM budget on a deterministic failure). They propagate here and the
 *     run is finalized as failed.
 *   - cancellation stays cooperative (the loop polls the run row for 'cancelling'); force-cancel
 *     additionally `terminate()`s the instance (instance id = run id).
 * Code OUTSIDE steps (config reads, prompt fetches, this class's guards) re-executes on every
 * engine wake-up and must stay read-only/idempotent.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { RunReporter } from './reporter';
import type { KernelEnv, StepRunner } from './types';

/** Params every agent run workflow receives (event payload, must stay JSON-serializable). */
export interface RunWorkflowParams {
  run_id: string;
  triggered_by?: string | null;
  /** Strategy context (events-calendar) / directive (creative-head) — free text. */
  strategy_context?: string | null;
  /** events-calendar: BO control mode 'auto' resolved at trigger time. */
  auto_approve?: boolean;
}

/** The agent-specific run function the workflow executes. It receives a `stepper` and MUST
 *  thread it into its top-level `runOrchestrator` (and around any non-idempotent finalize work)
 *  so the run checkpoints per turn. The resolved artifact is persisted by the agent itself. */
export type RunWorkflowExecute<E extends KernelEnv> = (
  env: E,
  reporter: RunReporter,
  params: RunWorkflowParams,
  stepper: StepRunner,
) => Promise<unknown>;

// Per-checkpoint step config. Retries exist for isolate death (the attempt dies without a JS
// throw — e.g. the engine's ~5-min per-attempt wall); in-code errors are made non-retryable
// below. Timeout is a per-attempt safety net, within the documented ≤30-minute step-timeout rule.
const STEP_CONFIG = {
  timeout: '15 minutes',
  retries: { limit: 3, delay: '5 seconds', backoff: 'constant' },
} as const;

/**
 * Build an agent's RunWorkflow class. Usage (per agent):
 *
 *   export const RunWorkflow = makeRunWorkflow<Env>('events-calendar', (env, reporter, p, stepper) =>
 *     runCalendarAgent(env, reporter, p.strategy_context ?? undefined,
 *       { autoApprove: p.auto_approve ?? false, stepper }));
 *
 * and in wrangler.jsonc (both envs):
 *   "workflows": [{ "binding": "RUN_WORKFLOW", "name": "<agent>-run", "class_name": "RunWorkflow" }]
 */
export function makeRunWorkflow<E extends KernelEnv>(
  agentId: string,
  execute: RunWorkflowExecute<E>,
) {
  return class RunWorkflow extends WorkflowEntrypoint<E, RunWorkflowParams> {
    async run(event: Readonly<WorkflowEvent<RunWorkflowParams>>, step: WorkflowStep): Promise<void> {
      const p = event.payload;
      const env = this.env as E;

      // Idempotency guard (re-checked on every engine wake-up): only execute while the run row
      // is still live. Protects against duplicate delivery and replay after finalization.
      const row = await env.DB.prepare('SELECT status FROM agent_runs WHERE id = ?')
        .bind(p.run_id).first<{ status: string }>().catch(() => null);
      if (!row || (row.status !== 'running' && row.status !== 'cancelling')) return;

      const reporter = new RunReporter(env, agentId, p.run_id);

      // The StepRunner contract (types.ts) makes callers promise serializable values; the
      // engine's Serializable<T> generic can't see that through an unconstrained T, so bridge
      // the callback with a cast.
      const stepper: StepRunner = <T>(name: string, fn: () => Promise<T>) =>
        step.do(name, STEP_CONFIG, (async () => {
          try {
            return await fn();
          } catch (err) {
            // In-code errors must not be engine-retried — the retry budget is reserved for
            // isolate death, where the attempt dies without throwing.
            throw new NonRetryableError(err instanceof Error ? err.message : String(err));
          }
        }) as () => Promise<never>) as Promise<T>;

      try {
        await execute(env, reporter, p, stepper);
      } catch (err) {
        console.error(`[${agentId}] run failed:`, err instanceof Error ? err.stack : String(err));
        await reporter.fail(err instanceof Error ? err.message : String(err));
        // Swallow: terminal status is recorded; an engine retry of run() is harmless (the guard
        // above sees the finalized row) but pointless.
      }
    }
  };
}
