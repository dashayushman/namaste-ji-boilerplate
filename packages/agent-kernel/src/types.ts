// Shared run-observability contracts for all agents (AGENT-KERNEL.md "single observability stream").

/** One entry in a run's step timeline: an LLM turn or a single tool invocation. */
export interface RunStep {
  phase: string;                 // e.g. 'research' | 'extract'
  step_index: number;
  type: 'llm' | 'tool';
  tool_name?: string | null;
  input?: unknown;               // tool args / llm detail (clipped + JSON-stringified on write)
  output?: unknown;              // tool result / llm text
  prompt_tokens?: number;
  completion_tokens?: number;
  finish_reason?: string | null;
}

/** Fields an agent supplies when a run completes. Token totals are accumulated by the reporter. */
export interface RunOutcome {
  provider?: string;
  model_id?: string;
  events_upserted?: number;
  events_total?: number;
  summary?: string;
  langfuse_trace_id?: string | null;
}

/** Lifecycle events emitted to the control plane for the central run index. */
export type RunEvent =
  | {
      type: 'run.started';
      agent_id: string;
      run_id: string;
      triggered_by?: string | null;
      strategy_context?: string | null;
      started_at: string;
    }
  | {
      type: 'run.finished';
      agent_id: string;
      run_id: string;
      status: 'completed' | 'failed' | 'cancelled';
      finished_at: string;
      provider?: string | null;
      model_id?: string | null;
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      tool_calls: number;
      events_upserted?: number;
      events_total?: number;
      summary?: string | null;
      error?: string | null;
      langfuse_trace_id?: string | null;
    }
  | {
      type: 'run.step';
      agent_id: string;
      run_id: string;
      phase: string;
      step_index: number;
      step_type: 'tool' | 'llm';
      tool_name?: string | null;
      input?: unknown;
      output?: unknown;
      prompt_tokens?: number;
      completion_tokens?: number;
      finish_reason?: string | null;
      created_at?: string;
    };

/**
 * Wraps one durable unit of work. Inside the Workflow executor this is `step.do`: the returned
 * value is checkpointed by the engine, the closure is re-attempted if the isolate dies mid-way,
 * and on replay (engine wake-up after a death) the stored value is returned WITHOUT re-executing
 * the closure. Outside a workflow it just runs the function. Returned values MUST be
 * JSON-serializable (they are persisted) and stay well under the 1 MiB step-result cap.
 */
export type StepRunner = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

/** Env bindings the kernel needs. All optional except DB. */
export interface KernelEnv {
  DB: D1Database;
  /** Queue sink for run events (staging/prod). When present, used over HTTP. */
  JOBS?: Queue;
  /** Service binding to the control plane (console-api). Preferred over CONTROL_PLANE_URL when
   *  present: worker-to-worker calls bypass Cloudflare Access (which is ingress-only), so internal
   *  run-event / control traffic reaches console-api even though its public hostname is Access-gated. */
  CONTROL_PLANE?: Fetcher;
  /** HTTP sink: control-plane base URL for run events (local dev fallback, non-Access hosts). */
  CONTROL_PLANE_URL?: string;
  /** Shared secret guarding the control-plane run-events ingest endpoint. */
  RUN_EVENT_SECRET?: string;
  ENVIRONMENT?: string;
}
