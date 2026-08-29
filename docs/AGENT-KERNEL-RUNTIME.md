<!-- Mirrored from the Namaste Ji monorepo. Living copy: https://namasteji.aiwithayushman.com/docs/agents/agent-kernel-runtime -->

# Agent Kernel — Runtime (implementation contract / playbook)

> Design rationale: [AGENT-KERNEL.md](AGENT-KERNEL.md) and [ORCHESTRATION.md](ORCHESTRATION.md).
> **This** doc is the concrete runtime — the reusable shape every agent instantiates. The first
> agent (`events-calendar`) is the reference; the next agent is a manifest + tools + prompts.

## The shape

```
agents/events-calendar          ← reference agent (tools + subagents + prompts + manifest)
  src/agent.ts   builds the tool/subagent roster + initial STM, calls runOrchestrator
  src/index.ts   HTTP surface (/run, /events*, /runs*, /memory*, /runs/:id/artifact, /mcp)
packages/agent-kernel           ← the reusable runtime (the playbook), imported by every agent
  orchestrator.ts  runOrchestrator — the bounded loop (one tool call per step, calibrated stop)
  stm.ts           the working-memory document + per-step stm-writer rewrite
  subagent.ts      defineSubagent — a subagent exposed to the parent as a tool (context firewall)
  mcp.ts           connectMcp — remote MCP tools (Tavily) as AI SDK tools
  tool-fallback.ts parse a tool call from text when a provider returns none
  model-port.ts    ModelPort: provider-agnostic LLM (Vercel AI SDK + AI Gateway, `.chat()`)
  memory-port.ts   MemoryPort: long-term memory (D1; Vectorize later)
  reporter/artifact/sink/gateway   run timeline, artifacts, run-events, AI Gateway tagging
```

## How an agent acts — orchestrator + tools + subagents

A thin **orchestrator** calls **one tool at a time**, each carrying an `objective`. Tools are
plain AI SDK tools — some direct functions, some **subagents** (their own bounded loop). The
orchestrator decides when it's done by calling `finish`; `maxLoops` is only a backstop.

Each loop (`runOrchestrator`):
1. The orchestrator LLM is shown the current **STM** and picks the single next action (one tool
   call). Structured tool calls are used; a thin **text fallback** parses one call from the
   model's text for providers that emit calls as text (some local llama.cpp setups).
2. The tool executes (function, MCP tool, or subagent). The raw `{objective, tool, args, output}`
   is recorded to the run-step timeline (`agent_run_steps`) — nothing is lost.
3. A dedicated **stm-writer** LLM call rewrites the WHOLE STM, integrating the outcome.

**STM** is one coherent Markdown document (`## Objective / ## Plan / TODO / ## Findings /
## Reasoning & progress / ## Coverage & confidence`) — anyone reading it understands the run at a
glance. It is the working memory + reasoning trace, and it is embedded in the final artifact.

**Subagents (context firewall):** `defineSubagent` runs a smaller orchestrator loop and returns a
**distilled artifact** (its final STM) — the parent never sees the raw transcript. The parent's
stm-writer then folds that artifact into the parent STM (double distillation). The
events-calendar roster: `research` (deep Tavily web research for one objective) and `plan`
(turns findings into the TODO).

**All web research goes through the Tavily MCP** (`connectMcp(tavilyMcpUrl(key))`), whose tools
are merged into the orchestrator and the `research` subagent. Connection is best-effort — if the
MCP is unreachable the run degrades (no research) rather than crashing.

## Reuse vs build (the playbook)

Kernel-provided (every agent inherits): `runOrchestrator`, STM + stm-writer, `defineSubagent`,
`connectMcp`, `ModelPort`, `MemoryPort`, `RunReporter`, artifacts, the text fallback. A new agent
declares only its **direct tools** (its `query_*` / `propose_*` / domain functions), its
**subagent roster**, and its **prompts** (orchestrator + subagents in Langfuse; `kernel/stm-writer`
is shared). That's the whole agent.

## Output

The run exits with (1) the D1 effect (validated events upserted; `approved` directly in `auto`
mode) and (2) a **Calendar Report** artifact (`agent_artifacts`) — frontmatter (coverage, counts,
this-run stats, memory) + a Markdown body that embeds the **final STM** (the agent's reasoning)
and the LTM lessons applied/learned. Fetch at `GET /runs/:id/artifact`.

## Model + tool calling

`ModelPort.buildModel` pins **Chat Completions** (`.chat()`) for OpenAI-shaped providers
(local llama.cpp only implements chat completions reliably; cloud OpenAI works too). Structured
tool calls require, locally, llama.cpp `--jinja` + a model with a **native tool template** —
**Qwen2.5-7B-Instruct** is the verified local pick (Hermes-3-8B is an alternative). Coder models
and unrecognized templates fall back to generic/text tool calls (handled by the text fallback).

## Status

- ✅ Orchestrator loop, coherent STM (+ per-step stm-writer), subagents (research/plan), Tavily
  MCP wiring, text fallback, ModelPort `.chat()` — built; the loop + STM verified end-to-end with
  Qwen2.5-7B-Instruct (structured tool calls confirmed).
- ✅ Code-execution (codemode / Worker Loaders) fully removed.
- ⏳ Live web research (Tavily) needs network access — blocked locally behind a TLS-inspecting
  VPN (the MCP cert can't be verified); works with the VPN off (same constraint as cloudflared).
- ⬜ Prompts authored in Langfuse (`name@label`) — currently in-code fallbacks; author + version
  in Langfuse (never auto-promote to `production`).
- ⬜ `KernelAgent` on the CF Agents SDK Durable Object (state/schedule/durable-fibers) — optional
  hardening; the agent runs as a Worker today.
