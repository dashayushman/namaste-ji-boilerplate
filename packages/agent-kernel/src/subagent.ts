/**
 * Subagent-as-tool (the context firewall — AGENT-KERNEL ORCHESTRATION OR-1/AK-4).
 *
 * A subagent is itself a bounded orchestrator loop with a smaller toolset. The parent calls it
 * as a tool with `{ objective, stm_projection }`; the subagent runs its own loop (its raw
 * transcript stays internal) and returns a DISTILLED artifact — its final working memory. The
 * parent's STM-writer then integrates that artifact into the parent STM. This keeps the parent's
 * context lean while subagents absorb the heavy work.
 */
import { tool, type LanguageModel, type Tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { runOrchestrator } from './orchestrator';
import { initStm } from './stm';
import type { RunStep } from './types';
import type { GenerateParams } from './model-port';
import type { RetryConfig } from './retry';

export interface SubagentDef {
  /** Tool name the parent calls (e.g. 'research', 'plan'). */
  name: string;
  /** What the parent sees — when to use this subagent. */
  description: string;
  /** The subagent's role/system prompt. */
  systemPrompt: string;
  /** The stm-writer prompt (shared across the run). */
  stmWriterPrompt: string;
  /** The subagent's own toolset (e.g. Tavily for `research`). A `finish` tool is injected. */
  tools: ToolSet;
  /** Model for the subagent (usually the same as the orchestrator). */
  model: LanguageModel;
  /** Generation params for the subagent model (temperature, providerOptions, …). */
  modelParams?: GenerateParams;
  /** Optional cheaper model for the subagent's STM rewrites. */
  stmWriterModel?: LanguageModel;
  /** Generation params for the subagent's STM-writer. Falls back to `modelParams` when unset. */
  stmWriterParams?: GenerateParams;
  /** Backstop for the subagent's inner loop. */
  maxLoops: number;
  /** Retry/backoff policy for the subagent's model calls. Inherit the parent's; defaults to DEFAULT_RETRY. */
  retry?: RetryConfig;
  /** Cooperative cancellation — propagated from the parent run. */
  shouldCancel?: () => Promise<boolean>;
  /** Forward the subagent's steps to the run trace (nested, phase-prefixed). */
  onStep?: (step: RunStep) => void;
  /** Live activity line (prefixed with the subagent name). */
  onActivity?: (activity: string) => void;
}

/** Build a subagent exposed to the parent orchestrator as a single tool. */
export function defineSubagent(def: SubagentDef): Tool {
  // The subagent signals completion by calling `finish` with its distilled artifact.
  const finishTool = tool({
    description: 'Call when you have gathered what the objective needs. Provide your distilled findings.',
    inputSchema: z.object({
      summary: z.string().describe('A concise, self-contained summary of what you found (the artifact the caller receives).'),
    }),
    execute: async ({ summary }) => ({ done: true, summary }),
  });

  return tool({
    description: def.description,
    inputSchema: z.object({
      objective: z.string().describe('What this subagent must achieve.'),
      stm_projection: z.string().optional().describe('Relevant context from the caller (read-only).'),
    }),
    execute: async ({ objective, stm_projection }) => {
      const stm = initStm({ objective, context: stm_projection ?? '' });
      const result = await runOrchestrator({
        model: def.model,
        modelParams: def.modelParams,
        stmWriterModel: def.stmWriterModel,
        stmWriterParams: def.stmWriterParams,
        systemPrompt: def.systemPrompt,
        stmWriterPrompt: def.stmWriterPrompt,
        tools: { ...def.tools, finish: finishTool },
        stm,
        maxLoops: def.maxLoops,
        retry: def.retry,
        shouldCancel: def.shouldCancel,
        onStep: def.onStep
          ? (s) => def.onStep!({ ...s, phase: `subagent:${def.name}` })
          : undefined,
        onActivity: def.onActivity
          ? (a) => def.onActivity!(`${def.name} · ${a.replace(/^turn \d+ · /, '')}`)
          : undefined,
      });
      // The distilled artifact is the summary the subagent passed to `finish` (e.g. research's
      // structured event list) — that's what the subagent chose to hand back. Fall back to its
      // final working memory only if it finished without a summary.
      return { subagent: def.name, objective, artifact: result.finishSummary ?? result.stm, loops: result.loops };
    },
  });
}
