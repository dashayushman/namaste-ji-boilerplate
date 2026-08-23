/**
 * Short-term (working) memory — one coherent document maintained across an orchestrator run.
 *
 * The STM is a single Markdown document with fixed sections. After EVERY tool/subagent call a
 * dedicated `stm-writer` LLM call rewrites the WHOLE document, folding the new outcome into the
 * right sections — so anyone reading the STM (orchestrator or subagent) instantly understands
 * the objective, plan, reasoning, and outcomes. It never appends raw fragments. The raw tool
 * output is recorded separately in the run-step timeline.
 */
import { generateText, type LanguageModel } from 'ai';
import { withRetry, DEFAULT_RETRY, type RetryConfig } from './retry';
import type { GenerateParams } from './model-port';

/** The fixed STM section skeleton. The stm-writer must preserve this structure. */
export function initStm(opts: { objective: string; context?: string }): string {
  return [
    `# Working memory`,
    ``,
    `## Objective`,
    opts.objective.trim(),
    ``,
    `## Plan / TODO`,
    `_(no plan yet — explore + research first, then build the TODO)_`,
    ``,
    `## Findings`,
    `_(none yet)_`,
    ``,
    `## Reasoning & progress`,
    opts.context?.trim() ? opts.context.trim() : `_(starting)_`,
    ``,
    `## Coverage & confidence`,
    `_(not assessed yet)_`,
    ``,
  ].join('\n');
}

const clip = (v: unknown, n = 6000): string => {
  // NOTE: JSON.stringify(undefined) returns undefined (and functions/symbols too), so guard it —
  // otherwise a tool that returns no value crashes the whole run on `s.length`.
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? '(no result)';
  return s.length > n ? s.slice(0, n) + '\n…[truncated]' : s;
};

/** One tool/subagent outcome from a turn (the orchestrator may produce several per turn). */
export interface StmOutcome {
  objective: string;
  tool: string;
  result: unknown;
}

export interface StmWriterOptions {
  model: LanguageModel;
  /** Resolved `stm-writer` prompt. Must reference {{stm}}, {{objective}}, {{result}}. */
  prompt: string;
  /** All outcomes from the turn to integrate (one or many). */
  outcomes: StmOutcome[];
  /** Hard cap on the rewritten document size — prevents runaway generation. Default 1500.
   *  Superseded by `params.maxOutputTokens` when set. */
  maxOutputTokens?: number;
  /** Generation params for the STM-writer model (temperature, providerOptions, …). */
  params?: GenerateParams;
  /** Retry/backoff policy for the rewrite call. Defaults to DEFAULT_RETRY. */
  retry?: RetryConfig;
}

/**
 * Rewrite the entire STM, integrating ALL of a turn's tool/subagent outcomes coherently.
 * Best-effort: on any failure the previous STM is returned unchanged so a writer hiccup never
 * aborts the run. Returns the new document plus the tokens the rewrite cost (so the caller can
 * fold STM-writer spend into the run's token totals — it's a non-trivial share of the bill).
 */
export interface StmRewriteResult {
  stm: string;
  usage: { prompt: number; completion: number };
}

export async function rewriteStm(stm: string, opts: StmWriterOptions): Promise<StmRewriteResult> {
  const objective = opts.outcomes.length === 1
    ? opts.outcomes[0].objective
    : `${opts.outcomes.length} actions this turn`;
  const resultBlock = opts.outcomes
    .map((o, i) => `### Action ${i + 1} — ${o.tool}\nObjective: ${o.objective}\nResult: ${clip(o.result, 3500)}`)
    .join('\n\n');
  const filled = opts.prompt
    .replaceAll('{{stm}}', stm)
    .replaceAll('{{objective}}', objective || '(unspecified)')
    .replaceAll('{{result}}', resultBlock);
  try {
    const { text, usage } = await withRetry(() => generateText({
      model: opts.model,
      prompt: filled,
      maxRetries: 0, // kernel owns retries
      maxOutputTokens: opts.maxOutputTokens ?? 1500,
      ...opts.params,
    }), opts.retry ?? DEFAULT_RETRY);
    const u = { prompt: usage?.inputTokens ?? 0, completion: usage?.outputTokens ?? 0 };
    const next = text.trim();
    // Guard: only accept a plausible rewrite (keeps the document structure).
    return { stm: next.includes('## ') && next.length > 40 ? next : stm, usage: u };
  } catch (e) {
    console.warn('[agent-kernel] stm rewrite failed (keeping prior STM):', e);
    return { stm, usage: { prompt: 0, completion: 0 } };
  }
}

/** Default fallback stm-writer prompt (used when Langfuse has none). */
export const DEFAULT_STM_WRITER_PROMPT =
  `You maintain an agent's WORKING MEMORY: one coherent Markdown document that anyone can read to ` +
  `instantly understand the objective, plan, reasoning, and outcomes so far.\n\n` +
  `Here is the current working memory:\n\n{{stm}}\n\n` +
  `This turn the agent completed one or more actions ({{objective}}). Their results:\n\n{{result}}\n\n` +
  `Rewrite the ENTIRE working memory document, integrating these outcomes:\n` +
  `- Keep the exact section headings: ## Objective, ## Plan / TODO, ## Findings, ## Reasoning & progress, ## Coverage & confidence.\n` +
  `- In Plan / TODO, mark any item this action completed as done ("- [x] … — outcome") and add new items if needed.\n` +
  `- In Findings, add the distilled facts/events (with date + source + confidence) — never paste raw search results.\n` +
  `- In Reasoning & progress, update the short narrative (including failures and what to do next).\n` +
  `- In Coverage & confidence, assess whether the objective is solved and what gaps remain.\n` +
  `- Preserve everything still relevant; remove only what is now obsolete; keep it concise and coherent.\n\n` +
  `Output ONLY the rewritten Markdown document.`;
