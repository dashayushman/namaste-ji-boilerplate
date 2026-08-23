/**
 * The orchestrator loop (the reusable Kernel runtime — the playbook).
 *
 * Each iteration is a TURN: the orchestrator may call as MANY tools as it needs (the AI SDK
 * multi-step loop runs them), then the shared STM is rewritten once with all of that turn's
 * outcomes. Tools are plain AI SDK tools — some direct functions, some subagents (subagent.ts).
 * The orchestrator decides when it's done by calling `finish` (gated for coverage) — there is no
 * turn budget; `maxLoops` is only a runaway safety guard and `maxToolsPerTurn` a per-turn cap.
 * Works with structured tool calls (cloud + configured
 * llama.cpp) and falls back to parsing one tool call from text for providers that emit it as text.
 *
 * Durable execution: under the Workflow executor every turn runs inside its own checkpointed
 * step (`stepper`). A turn's end state — the STM plus the agent-local tool state snapshot — is
 * everything the next turn needs, and it is JSON-serializable, so an isolate death mid-turn
 * costs at most that one turn: completed turns replay from engine storage without re-executing
 * (no LLM re-spend), and the loop resumes where it left off.
 *
 * Raw outputs are recorded to the run-step timeline; the integrated, coherent view lives in STM.
 */
import { generateText, stepCountIs, type LanguageModel, type ToolSet } from 'ai';
import type { RunStep, StepRunner } from './types';
import { rewriteStm, type StmOutcome } from './stm';
import { parseToolCallFromText } from './tool-fallback';
import type { GenerateParams } from './model-port';
import { withRetry, DEFAULT_RETRY, type RetryConfig } from './retry';

export interface RunOrchestratorOptions {
  /** Orchestrator model (drives the decisions). */
  model: LanguageModel;
  /** Optional cheaper/faster model for the per-turn STM rewrite (defaults to `model`). */
  stmWriterModel?: LanguageModel;
  /** Resolved orchestrator system prompt. */
  systemPrompt: string;
  /** Resolved stm-writer prompt (referencing {{stm}} {{objective}} {{result}}). */
  stmWriterPrompt: string;
  /** AI SDK tools available to the orchestrator. MUST include a `finish` tool. */
  tools: ToolSet;
  /** Initial STM document. */
  stm: string;
  /**
   * Optional runaway-safety backstop (max turns). The agent is finish-driven: it works until it
   * calls `finish` (gated by `onFinishAttempt` for coverage), NOT until a turn budget runs out.
   * This is only a guard against a model that never finishes; defaults high so it never bites a
   * competent one. Subagents pass an explicit small value (their focused depth).
   */
  maxLoops?: number;
  /** Max tool calls within one turn before the STM is refreshed. Default 6. */
  maxToolsPerTurn?: number;
  /** Hard cap on tokens per model call — prevents weak models running away. Default 1500.
   *  Superseded by `modelParams.maxOutputTokens` when that is set. */
  maxOutputTokens?: number;
  /** Generation params for the orchestrator model (temperature, providerOptions, …). */
  modelParams?: GenerateParams;
  /** Generation params for the STM-writer model. Falls back to `modelParams` when unset. */
  stmWriterParams?: GenerateParams;
  /** Retry/backoff policy for every model call in this loop (turn + STM rewrite). Defaults to DEFAULT_RETRY. */
  retry?: RetryConfig;
  /** Cooperative cancellation — checked at the start of each turn. */
  shouldCancel?: () => Promise<boolean>;
  /** Per-step trace hook (also returned). Fires live as each step completes. */
  onStep?: (step: RunStep) => void;
  /** Live activity line (e.g. "turn 2 · thinking…"). Fires at the start of each turn. */
  onActivity?: (activity: string) => void;
  /** Optional trace hook for Langfuse/observability. */
  onEvent?: (name: string, payload: unknown) => void;
  /**
   * Called when the model requests `finish`. Return `{ allow: false, nudge }` to deny the finish
   * and push the model to keep working (e.g. coverage still too thin); the nudge is injected into
   * the next turn. Capped by `maxFinishNudges` so it can never deadlock.
   */
  onFinishAttempt?: (ctx: { stm: string; loops: number }) =>
    | { allow: boolean; nudge?: string }
    | Promise<{ allow: boolean; nudge?: string }>;
  /** Max times `onFinishAttempt` may deny a finish before it's allowed regardless. Default 2. */
  maxFinishNudges?: number;
  /**
   * Durable-execution hook (the Workflow executor's `step.do`). When set, EVERY turn runs inside
   * its own checkpointed step: the turn's end state is persisted by the engine, an isolate death
   * mid-turn retries only that turn, and replayed turns return their stored state without
   * re-executing (no double LLM spend). Only the TOP-level loop of a workflow run may receive
   * this — subagent loops run inside a parent turn (workflow steps cannot nest).
   */
  stepper?: StepRunner;
  /**
   * Snapshot/restore for agent-local state that tools mutate OUTSIDE the STM (proposed briefs/
   * events, staged lessons, …). The snapshot rides in every turn checkpoint; after each turn —
   * live or replayed — it is fed back through `restoreState`, which is what rebuilds that state
   * when a killed run resumes. `snapshotState` MUST return a DETACHED, JSON-serializable copy
   * (use structuredClone); `restoreState` must tolerate receiving its own latest snapshot.
   */
  snapshotState?: () => unknown;
  restoreState?: (state: unknown) => void;
  /**
   * Soft wall-clock budget per turn, in ms. The Workflows engine kills a step attempt at ~5
   * minutes of wall time (observed on staging; the docs' "unlimited" does not hold), so when
   * running under `stepper` the in-flight LLM turn is aborted just before that window closes,
   * the tool outcomes that DID complete are integrated into the STM, and the loop continues in
   * the next checkpointed turn — nothing already-spent is lost. Defaults to 210s when `stepper`
   * is set (0 = disabled otherwise); pass 0 explicitly for environments without the wall
   * (local wrangler dev with slow local models).
   */
  turnWallBudgetMs?: number;
}

export interface OrchestratorResult {
  stm: string;
  /** The summary the model passed to `finish` — the distilled, caller-facing artifact (e.g. a
   *  subagent's structured findings). Falls back to the STM when no finish summary was produced. */
  finishSummary: string | null;
  finished: boolean;
  cancelled: boolean;
  loops: number;
  /** Steps executed by THIS isolate. After an executor restart, turns replayed from checkpoint
   *  storage don't re-execute, so their steps are absent here — the durable timeline is the
   *  run-step table written live via `onStep`. */
  steps: RunStep[];
  tokens: { prompt: number; completion: number };
}

const FINISH = 'finish';

/** Everything one turn hands to the next — persisted per turn by the durable executor. */
interface TurnCheckpoint {
  stm: string;
  finished: boolean;
  cancelled: boolean;
  finish_summary: string | null;
  nudges: number;
  pending_nudge: string;
  /** Cumulative across the run (so totals survive a resume). */
  prompt_tokens: number;
  completion_tokens: number;
  /** Agent-local tool state (opts.snapshotState) — restored via opts.restoreState. */
  agent_state?: unknown;
}

/** Run the bounded orchestrator loop (multi-tool turns + per-turn STM rewrite). */
export async function runOrchestrator(opts: RunOrchestratorOptions): Promise<OrchestratorResult> {
  let stm = opts.stm;
  const steps: RunStep[] = [];
  const toolNames = Object.keys(opts.tools);
  const turnCap = opts.maxToolsPerTurn ?? 6;
  let finished = false;
  let cancelled = false;
  let loops = 0;
  let promptTok = 0;
  let completionTok = 0;
  let nudges = 0;          // times a finish was denied for thin coverage
  let pendingNudge = '';   // message to inject into the next turn after a denied finish
  let finishSummary: string | null = null;  // the `finish` summary — the caller-facing artifact

  const push = (s: RunStep) => { steps.push(s); opts.onStep?.(s); };

  const runTurn: StepRunner = opts.stepper ?? (async (_name, fn) => fn());
  const turnBudget = opts.turnWallBudgetMs ?? (opts.stepper ? 210_000 : 0);

  // Finish-driven: the agent stops itself via `finish`; this is only a runaway guard.
  const RUNAWAY_GUARD = 50;
  const loopGuard = opts.maxLoops ?? RUNAWAY_GUARD;
  for (let i = 0; i < loopGuard; i++) {
    loops = i + 1;

    const cp = await runTurn(`turn-${i + 1}`, async (): Promise<TurnCheckpoint> => {
      // Reads the loop state LIVE at return time — every exit path below funnels through this.
      const checkpoint = (): TurnCheckpoint => ({
        stm, finished, cancelled, finish_summary: finishSummary,
        nudges, pending_nudge: pendingNudge,
        prompt_tokens: promptTok, completion_tokens: completionTok,
        agent_state: opts.snapshotState?.(),
      });

      if (opts.shouldCancel && (await opts.shouldCancel())) { cancelled = true; return checkpoint(); }
      opts.onActivity?.(`turn ${i + 1} · thinking…`);
      const nudgeLine = pendingNudge;  // consume any pending finish-gate nudge for this turn
      pendingNudge = '';

      // Responsive cancel: poll the cancel flag during the turn and abort the in-flight LLM call
      // (a single turn can take minutes on a slow model, so don't wait for the turn boundary).
      // The same controller enforces the per-turn wall budget — the flags tell the paths apart.
      const controller = new AbortController();
      let cancelRequested = false;
      let deadlineHit = false;
      const poll = opts.shouldCancel
        ? setInterval(() => { void opts.shouldCancel!().then((c) => { if (c) { cancelRequested = true; controller.abort(); } }).catch(() => {}); }, 3000)
        : null;
      const deadline = turnBudget > 0
        ? setTimeout(() => { deadlineHit = true; controller.abort(); }, turnBudget)
        : null;

      // Steps are recorded LIVE via onStepFinish (fires per step during the multi-step turn), so a
      // running run streams into the BO instead of appearing only when the turn completes.
      const outcomes: StmOutcome[] = [];
      let anyTool = false;
      let finishRequested = false;  // gated below so coverage can veto a premature finish
      const onStepFinish = (step: {
        text?: string;
        toolCalls?: { toolCallId: string; toolName: string; input?: unknown }[];
        toolResults?: { toolCallId: string; output?: unknown }[];
        usage?: { inputTokens?: number; outputTokens?: number };
        finishReason?: string;
        request?: { body?: unknown };
      }) => {
        const su = step.usage ?? {};
        promptTok += su.inputTokens ?? 0;
        completionTok += su.outputTokens ?? 0;
        const calls = step.toolCalls ?? [];
        // Record the orchestrator's GENERATION step — this is where the model "thinks" and decides
        // which tools to call, and it's the bulk of the run's token spend. Record it even when the
        // model emitted only tool calls (no visible text), otherwise those tokens never surface in
        // the timeline and the run looks like it's only made of (zero-token) tool calls.
        // `input` = the EXACT context sent to the model this step (system prompt + working memory +
        // tool defs); `output` = the model's generated prose, or its tool decision when it wrote none.
        if (step.text || calls.length > 0 || (su.inputTokens ?? 0) + (su.outputTokens ?? 0) > 0) {
          const decided = calls.length ? `Selected tool${calls.length > 1 ? 's' : ''}: ${calls.map((c) => c.toolName).join(', ')}` : '';
          push({
            phase: 'orchestrate', step_index: i, type: 'llm',
            input: step.request?.body ?? null,
            output: step.text || decided || null,
            prompt_tokens: su.inputTokens ?? 0, completion_tokens: su.outputTokens ?? 0,
            finish_reason: step.finishReason ?? null,
          });
        }
        const results = step.toolResults ?? [];
        calls.forEach((tc) => {
          anyTool = true;
          const res = results.find((r) => r.toolCallId === tc.toolCallId)?.output;
          const args = (tc.input ?? {}) as Record<string, unknown>;
          const objective = (typeof args.objective === 'string' && args.objective) || `${tc.toolName} call`;
          push({ phase: 'orchestrate', step_index: i, type: 'tool', tool_name: tc.toolName, input: args, output: res ?? null, finish_reason: null });
          opts.onEvent?.(`tool/${tc.toolName}`, { objective, args, result: res });
          if (tc.toolName === FINISH) {
            finishRequested = true;
            const sm = (args as { summary?: unknown }).summary;
            if (typeof sm === 'string' && sm.trim()) finishSummary = sm;
          } else outcomes.push({ objective, tool: tc.toolName, result: res ?? null });
        });
      };

      // ── One turn: the model may call several tools (AI SDK runs them) ──
      let gen: Awaited<ReturnType<typeof generateText>> | null = null;
      try {
        // Kernel owns retries (jittered exponential backoff on transient 429/5xx); disable the SDK's
        // own retry (maxRetries: 0) so we don't double-retry. Aborts are not retried (isRetryableError).
        gen = await withRetry(() => generateText({
          model: opts.model,
          system: opts.systemPrompt,
          stopWhen: stepCountIs(turnCap),
          maxRetries: 0,
          // Default token cap, overridable per-config; other params (temperature, providerOptions,
          // …) come straight from modelParams so config controls the full generation surface.
          maxOutputTokens: opts.maxOutputTokens ?? 1500,
          ...opts.modelParams,
          abortSignal: controller.signal,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onStepFinish: onStepFinish as any,
          messages: [{
            role: 'user',
            content:
              `Current working memory (STM):\n\n${stm}\n\n` +
              (nudgeLine ? `IMPORTANT — do not finish yet: ${nudgeLine}\n\n` : '') +
              `Work toward the objective. Call as many tools as you need this turn — each with an "objective". ` +
              `When the objective is fully solved, call \`${FINISH}\`.`,
          }],
          tools: opts.tools,
        }), opts.retry ?? DEFAULT_RETRY, {
          shouldCancel: opts.shouldCancel,
          onRetry: ({ attempt, delayMs, error }) => {
            const msg = error instanceof Error ? error.message : String(error);
            opts.onActivity?.(`LLM call failed — retry ${attempt} in ${Math.round(delayMs / 1000)}s (${msg.slice(0, 80)})`);
          },
        });
      } catch (e) {
        if (cancelRequested || (controller.signal.aborted && !deadlineHit)) { cancelled = true; return checkpoint(); }
        if (!deadlineHit) throw e;
        // Wall budget hit: keep everything the turn already completed. The outcomes collected so
        // far get integrated below; whatever was in flight is lost and the model is told so.
        opts.onEvent?.('orchestrator/turn-deadline', { turn: i + 1, salvaged: outcomes.length });
        opts.onActivity?.(`turn ${i + 1} · wall budget hit — checkpointing ${outcomes.length} outcome(s)`);
        outcomes.push({
          objective: 'per-turn wall budget', tool: 'system',
          result: `Turn ${i + 1} was cut off by the executor's wall-clock budget after ${outcomes.length} completed tool call(s). Their results are integrated; any call still in flight was lost — re-issue it next turn if still needed. Prefer fewer tool calls per turn.`,
        });
      } finally {
        if (poll) clearInterval(poll);
        if (deadline) clearTimeout(deadline);
      }

      // ── Text fallback: provider emitted no structured tool call this turn ──
      if (!anyTool && gen) {
        const parsed = parseToolCallFromText(gen.text, toolNames);
        if (parsed) {
          const t = opts.tools[parsed.name] as { execute?: (a: unknown, o: unknown) => Promise<unknown> } | undefined;
          let res: unknown;
          if (t?.execute) {
            try { res = await t.execute(parsed.args, { toolCallId: `fallback-${i}`, messages: [] }); }
            catch (e) { res = { error: String(e) }; }
          }
          const objective = (typeof parsed.args.objective === 'string' && parsed.args.objective) || `${parsed.name} call`;
          push({ phase: 'orchestrate', step_index: i, type: 'tool', tool_name: parsed.name, input: parsed.args, output: res ?? null, finish_reason: null });
          if (parsed.name === FINISH) {
            finishRequested = true;
            const sm = (parsed.args as { summary?: unknown }).summary;
            if (typeof sm === 'string' && sm.trim()) finishSummary = sm;
          } else outcomes.push({ objective, tool: parsed.name, result: res ?? null });
        } else {
          // Only text, no tool call — treat as a final answer (use the text as the artifact).
          opts.onEvent?.('orchestrator/no-tool-call', { text: gen.text?.slice(0, 200) });
          if (gen.text?.trim()) finishSummary = gen.text;
          finished = true;
        }
      }

      // ── Finish gate: let the caller veto a premature finish (e.g. coverage too thin) ──
      if (finishRequested) {
        const canNudge = !!opts.onFinishAttempt && nudges < (opts.maxFinishNudges ?? 2);
        const verdict = canNudge ? await opts.onFinishAttempt!({ stm, loops }) : { allow: true };
        if (verdict.allow) {
          finished = true;
        } else {
          nudges++;
          pendingNudge = verdict.nudge ?? 'Coverage is still thin — keep filling the remaining gaps before finishing.';
          opts.onEvent?.('orchestrator/finish-denied', { nudges, nudge: pendingNudge });
        }
      }

      if (finished || outcomes.length === 0) return checkpoint();

      // ── Integrate the turn's outcomes into the STM (one coherent rewrite) ──
      const rewrite = await rewriteStm(stm, {
        model: opts.stmWriterModel ?? opts.model,
        prompt: opts.stmWriterPrompt,
        outcomes,
        maxOutputTokens: opts.maxOutputTokens,
        params: opts.stmWriterParams ?? opts.modelParams,
        retry: opts.retry ?? DEFAULT_RETRY,
      });
      stm = rewrite.stm;
      promptTok += rewrite.usage.prompt;
      completionTok += rewrite.usage.completion;
      push({
        phase: 'orchestrate', step_index: i, type: 'llm',
        tool_name: 'stm-writer', input: outcomes.map((o) => o.objective).join(' · '), output: stm,
        prompt_tokens: rewrite.usage.prompt, completion_tokens: rewrite.usage.completion,
        finish_reason: 'stm-rewrite',
      });
      return checkpoint();
    });

    // Adopt the checkpoint. On a live turn this re-assigns the values just computed (no-op);
    // on a REPLAYED turn (engine wake-up after an isolate death) the closure never ran and this
    // is what restores the loop — and, via restoreState, the agent's tool state.
    stm = cp.stm;
    finished = cp.finished;
    cancelled = cp.cancelled;
    finishSummary = cp.finish_summary;
    nudges = cp.nudges;
    pendingNudge = cp.pending_nudge;
    promptTok = cp.prompt_tokens;
    completionTok = cp.completion_tokens;
    if (cp.agent_state !== undefined) opts.restoreState?.(cp.agent_state);

    if (cancelled || finished) break;
  }

  return { stm, finishSummary, finished, cancelled, loops, steps, tokens: { prompt: promptTok, completion: completionTok } };
}
