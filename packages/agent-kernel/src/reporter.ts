import type { KernelEnv, RunStep, RunOutcome } from './types';
import { emitRunEvent } from './sink';

const TRUNC = 16000;
const clip = (s: unknown): string | null => {
  if (s == null) return null;
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return str.length > TRUNC ? str.slice(0, TRUNC) + '…[truncated]' : str;
};

/**
 * RunReporter — the one place every agent records a run.
 *
 * Writes the run + step timeline to the agent's own D1 (offline-friendly source of truth)
 * AND emits lifecycle events to the control plane for the cross-agent run index. Token
 * totals + tool-call counts are accumulated from the steps you record.
 *
 * Lifecycle: new RunReporter(...) → start() → recordSteps()* → finish() | fail().
 */
export class RunReporter {
  private promptTokens = 0;
  private completionTokens = 0;
  private toolCalls = 0;

  constructor(
    private readonly env: KernelEnv,
    public readonly agentId: string,
    public readonly runId: string,
  ) {}

  get tokens() {
    return {
      prompt: this.promptTokens,
      completion: this.completionTokens,
      total: this.promptTokens + this.completionTokens,
      tool_calls: this.toolCalls,
    };
  }

  /** Insert the run row (status=running) and announce run.started. */
  async start(opts: { triggeredBy?: string | null; strategyContext?: string | null } = {}): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO agent_runs (id, status, strategy_context, triggered_by) VALUES (?, 'running', ?, ?)`
    ).bind(this.runId, opts.strategyContext ?? null, opts.triggeredBy ?? null).run().catch(() => {});

    await emitRunEvent(this.env, {
      type: 'run.started',
      agent_id: this.agentId,
      run_id: this.runId,
      triggered_by: opts.triggeredBy ?? null,
      strategy_context: opts.strategyContext?.slice(0, 500) ?? null,
      started_at: new Date().toISOString(),
    });
  }

  /** Append steps to the timeline and accumulate token/tool totals. Best-effort. */
  async recordSteps(steps: RunStep[]): Promise<void> {
    if (steps.length === 0) return;
    for (const s of steps) {
      this.promptTokens += s.prompt_tokens ?? 0;
      this.completionTokens += s.completion_tokens ?? 0;
      if (s.type === 'tool') this.toolCalls++;
    }
    const stmt = this.env.DB.prepare(`
      INSERT INTO agent_run_steps
        (run_id, phase, step_index, type, tool_name, input, output, prompt_tokens, completion_tokens, finish_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    await this.env.DB.batch(steps.map(s => stmt.bind(
      this.runId, s.phase, s.step_index, s.type,
      s.tool_name ?? null, clip(s.input), clip(s.output),
      s.prompt_tokens ?? 0, s.completion_tokens ?? 0, s.finish_reason ?? null,
    ))).catch(e => console.warn('[agent-kernel] recordSteps failed (non-fatal):', e));
  }

  /**
   * Persist ONE step immediately (so a running run shows live in the BO) and update the live
   * heartbeat: the current activity line (tool steps) and the working-memory snapshot (the
   * stm-writer step's output). Best-effort. Accumulates token/tool totals like recordSteps.
   */
  async recordStep(s: RunStep): Promise<void> {
    this.promptTokens += s.prompt_tokens ?? 0;
    this.completionTokens += s.completion_tokens ?? 0;
    if (s.type === 'tool') this.toolCalls++;

    await this.env.DB.prepare(`
      INSERT INTO agent_run_steps
        (run_id, phase, step_index, type, tool_name, input, output, prompt_tokens, completion_tokens, finish_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      this.runId, s.phase, s.step_index, s.type,
      s.tool_name ?? null, clip(s.input), clip(s.output),
      s.prompt_tokens ?? 0, s.completion_tokens ?? 0, s.finish_reason ?? null,
    ).run().catch((e) => console.warn('[agent-kernel] recordStep failed (non-fatal):', e));

    try {
      if (s.tool_name === 'stm-writer' && typeof s.output === 'string') {
        await this.env.DB.prepare('UPDATE agent_runs SET current_stm = ? WHERE id = ?')
          .bind(s.output.slice(0, 12000), this.runId).run();
      } else if (s.type === 'tool' && s.tool_name) {
        const obj = s.input && typeof s.input === 'object' && 'objective' in s.input
          ? String((s.input as { objective?: unknown }).objective ?? '').slice(0, 140) : '';
        const activity = `turn ${(s.step_index ?? 0) + 1} · ${s.tool_name}${obj ? ' — ' + obj : ''}`;
        await this.env.DB.prepare('UPDATE agent_runs SET current_activity = ? WHERE id = ?')
          .bind(activity, this.runId).run();
      }
    } catch { /* best-effort heartbeat */ }
  }

  /** Update the live activity line (e.g. "turn 2 · thinking…"). Best-effort. */
  async setActivity(activity: string): Promise<void> {
    await this.env.DB.prepare('UPDATE agent_runs SET current_activity = ? WHERE id = ?')
      .bind(activity.slice(0, 200), this.runId).run().catch(() => {});
  }

  /**
   * After an executor restart this reporter instance only saw the turns that ran in ITS isolate;
   * earlier turns' steps are already in D1. Fold the durable timeline back into the counters
   * (taking the max per counter so a lost D1 write can never shrink live totals). Best-effort.
   */
  private async reconcileTotals(): Promise<void> {
    const row = await this.env.DB.prepare(`
      SELECT COALESCE(SUM(prompt_tokens), 0) AS pt, COALESCE(SUM(completion_tokens), 0) AS ct,
             COALESCE(SUM(CASE WHEN type = 'tool' THEN 1 ELSE 0 END), 0) AS tc
      FROM agent_run_steps WHERE run_id = ?
    `).bind(this.runId).first<{ pt: number; ct: number; tc: number }>().catch(() => null);
    if (!row) return;
    this.promptTokens = Math.max(this.promptTokens, row.pt ?? 0);
    this.completionTokens = Math.max(this.completionTokens, row.ct ?? 0);
    this.toolCalls = Math.max(this.toolCalls, row.tc ?? 0);
  }

  /** Mark the run completed, persist totals, and announce run.finished. */
  async finish(out: RunOutcome = {}): Promise<void> {
    await this.reconcileTotals();
    const t = this.tokens;
    await this.env.DB.prepare(`
      UPDATE agent_runs SET finished_at = datetime('now'), status = 'completed',
        events_upserted = ?, events_total = ?, summary = ?, langfuse_trace_id = ?,
        provider = ?, model_id = ?, prompt_tokens = ?, completion_tokens = ?,
        total_tokens = ?, tool_calls = ?
      WHERE id = ?
    `).bind(
      out.events_upserted ?? 0, out.events_total ?? 0, out.summary ?? null,
      out.langfuse_trace_id ?? null, out.provider ?? null, out.model_id ?? null,
      t.prompt, t.completion, t.total, t.tool_calls, this.runId,
    ).run().catch(e => console.warn('[agent-kernel] finish update failed:', e));

    await emitRunEvent(this.env, {
      type: 'run.finished',
      agent_id: this.agentId,
      run_id: this.runId,
      status: 'completed',
      finished_at: new Date().toISOString(),
      provider: out.provider ?? null,
      model_id: out.model_id ?? null,
      prompt_tokens: t.prompt,
      completion_tokens: t.completion,
      total_tokens: t.total,
      tool_calls: t.tool_calls,
      events_upserted: out.events_upserted ?? 0,
      events_total: out.events_total ?? 0,
      summary: out.summary ?? null,
      langfuse_trace_id: out.langfuse_trace_id ?? null,
    });
  }

  /** Mark the run failed (persists whatever steps/tokens were captured) and announce it. */
  async fail(error: string, out: RunOutcome = {}): Promise<void> {
    await this.reconcileTotals();
    const t = this.tokens;
    await this.env.DB.prepare(`
      UPDATE agent_runs SET status = 'failed', error = ?, finished_at = datetime('now'),
        provider = ?, model_id = ?, prompt_tokens = ?, completion_tokens = ?,
        total_tokens = ?, tool_calls = ?
      WHERE id = ?
    `).bind(
      error, out.provider ?? null, out.model_id ?? null,
      t.prompt, t.completion, t.total, t.tool_calls, this.runId,
    ).run().catch(() => {});

    await emitRunEvent(this.env, {
      type: 'run.finished',
      agent_id: this.agentId,
      run_id: this.runId,
      status: 'failed',
      finished_at: new Date().toISOString(),
      provider: out.provider ?? null,
      model_id: out.model_id ?? null,
      prompt_tokens: t.prompt,
      completion_tokens: t.completion,
      total_tokens: t.total,
      tool_calls: t.tool_calls,
      error,
      langfuse_trace_id: out.langfuse_trace_id ?? null,
    });
  }

  /** Mark the run cancelled (cooperative stop) and announce it. Partial steps are preserved. */
  async cancel(out: RunOutcome = {}): Promise<void> {
    await this.reconcileTotals();
    const t = this.tokens;
    await this.env.DB.prepare(`
      UPDATE agent_runs SET status = 'cancelled', finished_at = datetime('now'),
        provider = ?, model_id = ?, prompt_tokens = ?, completion_tokens = ?,
        total_tokens = ?, tool_calls = ?, summary = ?
      WHERE id = ?
    `).bind(
      out.provider ?? null, out.model_id ?? null,
      t.prompt, t.completion, t.total, t.tool_calls, out.summary ?? 'Cancelled by operator', this.runId,
    ).run().catch(() => {});

    await emitRunEvent(this.env, {
      type: 'run.finished',
      agent_id: this.agentId,
      run_id: this.runId,
      status: 'cancelled',
      finished_at: new Date().toISOString(),
      provider: out.provider ?? null,
      model_id: out.model_id ?? null,
      prompt_tokens: t.prompt,
      completion_tokens: t.completion,
      total_tokens: t.total,
      tool_calls: t.tool_calls,
      summary: out.summary ?? 'Cancelled by operator',
      langfuse_trace_id: out.langfuse_trace_id ?? null,
    });
  }
}
