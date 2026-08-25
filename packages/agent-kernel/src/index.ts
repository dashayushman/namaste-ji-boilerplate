/**
 * @namaste-ji/agent-kernel
 *
 * Reusable agent run-instrumentation (AGENT-KERNEL.md). Every agent records runs the same
 * way: a step-level timeline + token/tool accounting in its own D1, lifecycle events to the
 * control plane for the cross-agent run index, and AI Gateway request tagging. Langfuse
 * remains the deep trace store (enriched per step by the agent); this kernel guarantees the
 * control-plane visibility every agent needs without per-agent code.
 */
export { RunReporter } from './reporter';
export { emitRunEvent } from './sink';
export { makeRunWorkflow } from './workflow';
export type { RunWorkflowParams, RunWorkflowExecute } from './workflow';
export { gatewayMetadataHeaders } from './gateway';
export { buildModel, resolveModelConfig, mergeModelSelection, toGenerateParams, assertVisionCapable, TEXT_ONLY_PROVIDERS } from './model-port';
export type { ModelPortEnv, ModelSelection, GenerateParams } from './model-port';
export { writeArtifact, artifactToMarkdown } from './artifact';
export type { RunArtifact } from './artifact';
export { createD1MemoryPort } from './memory-port';
export type {
  MemoryPort, MemoryRecord, RecalledMemory, MemoryKind, MemoryStatus,
  RecallOptions, EmbedderPort,
} from './memory-port';
export { runOrchestrator } from './orchestrator';
export type { RunOrchestratorOptions, OrchestratorResult } from './orchestrator';
export { initStm, rewriteStm, DEFAULT_STM_WRITER_PROMPT } from './stm';
export type { StmOutcome } from './stm';
export { parseToolCallFromText } from './tool-fallback';
export type { ParsedToolCall } from './tool-fallback';
export { connectMcp, tavilyMcpUrl, tavilyRestTools } from './mcp';
export type { McpConnection } from './mcp';
export { defineSubagent } from './subagent';
export type { SubagentDef } from './subagent';
export type { RunStep, RunOutcome, RunEvent, KernelEnv, StepRunner } from './types';
export { withRetry, isRetryableError, DEFAULT_RETRY } from './retry';
export type { RetryConfig, WithRetryHooks } from './retry';
