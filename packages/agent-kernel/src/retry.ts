/**
 * Retry with jittered exponential backoff for AI/LLM calls (AGENT-KERNEL).
 *
 * Provider calls fail transiently — 429 rate-limits and 5xx errors (e.g. OpenAI's generic
 * "An error occurred while processing your request") — especially under bursty multi-call runs.
 * `withRetry` wraps a single attempt and retries it on *transient* errors only, backing off
 * exponentially with jitter. It is applied to every kernel model call (orchestrator turn,
 * STM rewrite) and is reused for agent-level calls (vision, playbook). Tunable via RetryConfig;
 * the AI SDK's own retry is disabled at the call site (maxRetries: 0) so this is the single owner.
 */
import { type RetryConfig, DEFAULT_RETRY } from '@namaste-ji/config';

export { type RetryConfig, DEFAULT_RETRY };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pull an HTTP-ish status code off whatever error shape the AI SDK / fetch throws. */
function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;
  for (const k of ['statusCode', 'status', 'code']) {
    const v = e[k];
    if (typeof v === 'number') return v;
  }
  return undefined;
}

/**
 * Decide whether an error is worth retrying. Retry on rate-limits (429), request-timeout/conflict
 * (408/409/425), and any 5xx; on transient network errors (no status); and when the AI SDK marks
 * the error `isRetryable`. NEVER retry a cooperative abort, or a deterministic 4xx (bad request,
 * auth, not-found) that will just fail again.
 */
export function isRetryableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  if (e.name === 'AbortError') return false;
  if (typeof e.isRetryable === 'boolean') return e.isRetryable;
  const status = statusOf(err);
  if (status === undefined) return true; // network/transport error with no HTTP status → transient
  if (status === 408 || status === 409 || status === 425 || status === 429) return true;
  return status >= 500;
}

export interface WithRetryHooks {
  /** Called before each backoff sleep. Use it to surface "retrying…" in the run activity line. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /** Optional cooperative cancel — checked before each retry so a cancelled run stops backing off. */
  shouldCancel?: () => Promise<boolean> | boolean;
}

/** Run `fn`, retrying transient failures with jittered exponential backoff per `cfg`. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  cfg: RetryConfig = DEFAULT_RETRY,
  hooks: WithRetryHooks = {},
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= cfg.max_retries || !isRetryableError(err)) throw err;
      if (hooks.shouldCancel && (await hooks.shouldCancel())) throw err;
      const base = Math.min(cfg.max_delay_ms, cfg.initial_delay_ms * cfg.factor ** attempt);
      const delayMs = cfg.jitter === false ? base : Math.round(base * (0.5 + Math.random() * 0.5));
      attempt += 1;
      hooks.onRetry?.({ attempt, delayMs, error: err });
      await sleep(delayMs);
    }
  }
}
