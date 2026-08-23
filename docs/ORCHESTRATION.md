# Karkhana — Multi-Agent Orchestration Design

> **Status: design / brainstorm.** Nothing here is built yet. This is the agreed
> *direction* for how the Chief of Content & Product agent — and the agents it
> commands — are structured as a multi-agent system. Read
> [AGENT-PLATFORM.md](./AGENT-PLATFORM.md) first for the single-agent anatomy
> (manifest, MemoryPort, ModelPort, reflection loop). This document is the
> **topology layer above that**: how agents relate to each other, the two-plane
> (online/offline) model, and the memory/knowledge split.

---

## 1. The core insight: subagents as tools

The Chief of Content & Product is a **thin orchestrator**. It holds a plan,
a working memory, and a dispatch table. It does *not* contain domain logic.
When it needs to explore, analyze, or commission, it calls a **subagent as a
tool** — that subagent owns its own toolset, its own inner loop, and its own
scratch memory. It returns a *distilled* artifact + decision lineage to the
orchestrator's working memory. The orchestrator's context never sees the raw
transcript.

This is the **context firewall**: an exploration subagent can burn 40k tokens
sweeping the catalog and return a 300-token candidate set. The orchestrator
stays fast and cheap. Without this split the loop drowns in its own transcript
— the same scalability limit identified as the central risk in §3 of
AGENT-PLATFORM.md.

Implication: "making the Chief more capable" means adding or improving
*subagents*, not loading the orchestrator with more tools.

---

## 2. The two-plane model (online / offline)

The system runs on two clocks. They share state through the substrate (D1,
Vectorize, R2, the catalog view); they never block each other.

```
┌─────────────────────────────────────────────────────────────────┐
│  ONLINE — request-time, bounded loop                            │
│                                                                 │
│  Trigger (cron / BO / founder)                                  │
│       │                                                         │
│  ┌────▼──────────────────────────────────────────────────────┐  │
│  │  Orchestrator (Chief of Content & Product)                │  │
│  │  Working memory: plan · findings + lineage · coverage     │  │
│  │         │            │              │            │         │  │
│  │  Exploration   Code-exec    Commission    Memory recall   │  │
│  │  subagent      subagent     subagent      (tool)          │  │
│  └───────────────────────┬───────────────────────────────────┘  │
│                          │ Control DO gate (coverage / veto)     │
│                          ▼                                       │
│                   submit_decision                                │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  OFFLINE — continuous, scheduled (Workflows + Cron)             │
│                                                                 │
│  Catalog Steward ──────────► Catalog View (materialized)        │
│  (taxonomy · gaps · rollups · calendar-keying)                  │
│                                                                 │
│  Consolidation agent ──────► Long-term memory (MemoryPort)      │
│  (distil episodes → reinforce / supersede / decay lessons)      │
└─────────────────────────────────────────────────────────────────┘

Shared substrate: D1 · R2 · Vectorize · one multimodal index · AI Gateway
```

### Why decouple freshness from request time

The orchestrator reads the Catalog View **on demand, cheaply, instantly** —
no live sweep. The Steward pays the cost of keeping it fresh *off the hot
path* (scheduled Workflow). Live exploration subagents fire only on a *miss*
— when the view can't answer the question. The orchestrator's speed is
therefore a function of Steward cache hit rate, not catalog size.

Corollary: **the Steward's coverage is the load-bearing architectural bet.**
If it covers most questions, the online plane is fast. If not, every request
pays live-dig latency. Design the Steward before optimizing the orchestrator.

---

## 3. Three-tier memory / knowledge split

The trap is collapsing these. They have different write paths and different
trust models.

| Tier | What it holds | Lifetime | Write path |
|---|---|---|---|
| **Working memory** | This run's plan, distilled subagent findings + their decision lineage, coverage map | Per run, ephemeral | Subagents write distilled artifacts into it; never raw transcripts |
| **Long-term memory** | What the agent *learned*: episodic (decision + outcome), semantic (learned facts), procedural (distilled lessons) | Across runs, durable | Graded-outcomes-only (AP-6); Consolidation agent distils offline |
| **Catalog View** | Current state of the world: what content exists, coverage gaps, performance rollups, calendar-keying | Continuously refreshed | Catalog Steward writes; orchestrator reads; never written by the Chief |

Long-term memory is *the agent's opinion about how to do its job, with
confidence*. The Catalog View is *facts about the current world*. Never mix
their write paths.

Each subagent also gets its **own** scratch working memory, isolated from the
orchestrator's — that is the context firewall. The parent's working memory
only ever receives the distilled return value.

### Decision lineage ≠ user-facing citations

User-facing citations don't matter here (no end-user reading a footnote). But
*provenance* of every decision does, because:

1. The founder reviews it at the Control DO HITL gate.
2. The learning loop grades it — a vetoed decision must not teach "do more
   of this."

So every entry in working memory carries its evidence trail (which asset
signals / recalled lessons led to it). This feeds both Control DO review and
the post-run memory write-back.

---

## 4. The subagent roster

### Catalog Steward (offline, scheduled)

Runs as a Workflow on a cron schedule (and event-triggered on significant
catalog mutations). Maintains the **materialized Catalog View**:
- Occasion × locale × deity × theme taxonomy with counts
- Coverage and gap map (what's missing, what's thin)
- Performance rollups (Judge tier, share-signal) per cell
- Calendar-keying: upcoming festivals + lead times, freshness of time-bound
  assets

This agent is not creative. It is a **maintenance worker**. It reads the raw
catalog (D1 + Vectorize) and writes a structured, query-ready view.

### Exploration subagent (online, on miss)

Fires when the Catalog View can't answer a question — a genuine discovery
task. Has a four-level zoom ladder:

1. **Catalog map** (in-memory, free) — taxonomy + counts from the view.
2. **Asset scout** (multimodal KNN over summary vectors, compact result) —
   cross-lingual semantic discovery; returns IDs + one-liners, no synthesis.
3. **Asset card** (fetch-on-demand for a handful) — long description + Judge
   scorecard + performance signal + lineage.
4. **Analysis** (heavy LLM call) — synthesizes a finding from cards + signals
   + recalled lessons; returns finding + decision lineage.

Returns a distilled candidate set + finding to the orchestrator working
memory. Its own transcript is ephemeral.

### Code-exec subagent (online, analytics tasks)

Runs in Code Mode. Writes TypeScript against a typed catalog/index API and
executes it in a sandboxed Worker. This is the analytics agent: coverage
across 200 locale × occasion cells, theme share-lift ranking, freshness decay
curves, anything that is awkward as a fixed tool and natural as code. Far more
general than a collection of bespoke `analyze_*` tools.

**Scope-bound hard**: it sees only the typed catalog API, not raw D1 or R2
credentials. Compute anything, but only over the data the manifest grants.

### Commission subagent (online, write path)

The write-side agent. Takes an objective + scope + constraints and:
- Authors a `brief@vN` (the brief contract — see CREATIVE-PLANE.md)
- Delegates to creative pipeline subagents

Routes through Control DO when autonomy ≠ `auto`. In `proposes` mode
(default for the Chief) it drafts commissions; the founder approves before
they execute.

### Consolidation agent (offline, scheduled)

Runs nightly (and per-run write-back for low-cost episodes). Reads the
ungraded episodic log and distils:
- **Reinforce** a lesson (↑ confidence / support count)
- **Supersede** a contradicted one (validity window closed)
- **Decay** stale lessons (configurable per domain — seasonal vs evergreen)

Only fires the learning loop for **verified outcomes** (Judge pass / human
validation / share signal) — AP-6. Ungraded episodes stay episodic, waiting
for a signal.

---

## 5. The bounded loop

```
Question + Catalog View snapshot + loop_index / max_loops
   │
   ▼
recall_lessons (scoped to this task's locale/occasion/theme)
   │
   ▼
Plan (orchestrator: what subagents, what order, early-launch?)
   │
   ▼
Dispatch (subagent calls in parallel where possible)
   │
   ▼
Write distilled results into working memory
   │
   ▼
Coverage gate: enough signal? gaps + budget left?
   ├── yes, gaps, budget → loop back to Dispatch
   └── no gaps OR budget out OR last loop → Control DO gate
                                                  │
                               ├── confidence OK, no veto → submit_decision
                               └── low confidence / cultural veto → escalate to founder
```

**Every level has its own max_loops.** Orchestrator has one, each subagent
has one, Commission spawns creatives that have their own. Depth is never
unbounded. Control DO owns the *outer* stop/escalate.

**The loop runs inside a single invocation** — it is not an outer re-invocation
loop. An outer reflection gate (Think Longer / `auto` mode) can re-invoke the
whole agent, but the inner loop runs in every mode including `proposes`.

### Per-mode behaviour

Maps to the Control DO `autonomy` field in the manifest:

| Mode | Behaviour |
|---|---|
| `manual` | No inner loop. Founder drives; orchestrator answers a direct question from the Catalog View + one scout. |
| `proposes` (default) | Inner loop runs to completion. Commissions and roadmap writes are **drafted**, not committed — go to founder review. |
| `auto` | Inner loop + outer reflection gate. Low-risk commissions execute; cultural veto + low-confidence still escalate. |

---

## 6. Observability — single stream, no new channels

Each subagent is an `AsyncGenerator` yielding into the same
`agents/observability` stream the BO run console and Mission Control consume.
The orchestrator `async for event in subagent.run(): yield event`. No
separate SSE channel per subagent.

Emit structured events with stable `tool`/`step` codes; localize labels in
the BO. Never bake English strings into the stream (this is a vernacular
product).

Two events per step (started `complete=false`, finished `complete=true`).
Shared `EventIdManager` across orchestrator + all subagents — no id collisions.

---

## 7. Known risks and tradeoffs

**Steward coverage is the critical dependency.** If the Catalog View doesn't
cover most questions the orchestrator gets, every request pays live-dig
latency and the topology's main benefit evaporates. Invest in the Steward
early and measure cache hit rate as a first-class metric.

**Subagent cold context costs latency.** Each spawn re-derives its situation.
Mitigated by (a) the Steward (fewer misses), (b) compact, dense subagent
prompts over rich manifest context, (c) parallel dispatch where subagents are
independent.

**Recursive orchestration can run away.** Every level needs a budget.
Control DO owns the outer gate, but each subagent manifest must also declare
`max_loops` — don't rely on the orchestrator catching runaway inner loops.

**Code-exec agent is high capability / high risk.** Most analytically powerful
subagent; also the one that most needs sandboxing and strict data-API scoping.
Gate it hard: read-only typed API, no raw bindings, no egress except
AI Gateway.

**Offline agents need the same discipline.** Steward and Consolidation are
themselves agents: they need manifests, MemoryPort access, observability, and
their own Control DO modes. Don't treat offline as "just a cron job."

---

## 8. Open questions

- **Steward refresh triggers.** Cron cadence + event triggers (new content
  ingested, festival calendar update, share signal arrives). What's the
  minimum freshness guarantee the orchestrator can rely on?
- **Cache-miss → live-dig contract.** When the Exploration subagent runs on a
  miss, does it write back into the Catalog View, or only into working memory?
  Probably both (opportunistic cache warm) — needs a cache-write policy.
- **Parallel dispatch policy.** Which subagent calls can run in parallel
  (independent scopes) vs. must sequence (one's output feeds the next)? The
  orchestrator decides per plan; but the manifest could declare default
  parallelism hints.
- **Consolidation cadence.** Write-back per run (cheap, immediate) vs. nightly
  batch vs. both. Current direction: both — per-run for low-cost episodes,
  nightly batch for expensive distillation.
- **Cross-subagent working memory sharing.** Can two subagents in the same run
  read each other's scratch memory, or only through the orchestrator? Current
  direction: only through the orchestrator (cleaner contract, no cross-agent
  state leakage).
- **Commission subagent autonomy.** When the Chief is in `auto` mode, what
  gates the Commission subagent itself? It likely needs its own inner
  `proposes` default regardless of the orchestrator mode — committing a brief
  is consequential.

---

## 9. Relationship to other docs

| Doc | Relationship |
|---|---|
| [AGENT-PLATFORM.md](./AGENT-PLATFORM.md) | Single-agent anatomy — manifest, MemoryPort, ModelPort, reflection loop. This doc is the topology layer above it. Every agent in this doc is built on that foundation. |
| [CREATIVE-PLANE.md](../CREATIVE-PLANE.md) | The brief contract, content lifecycle, eval/Judge, ingest. The Commission subagent delegates into that plane. |
| [ARCHITECTURE.md](../ARCHITECTURE.md) | Two-plane design, Control DO policy engine, observability. This doc instantiates those abstractions for the Chief + its subagents. |
| [BACK-OFFICE.md](../BACK-OFFICE.md) | The substrate (Agents SDK + Workflows) and the BO management surfaces. All agents here run on that substrate and are managed through those surfaces. |
| [DISTRIBUTION.md](../DISTRIBUTION.md) | The Catalog View's performance rollups feed from the distribution signal (share-intent, novelty/rarity). |

---

## 10. Decisions log

| # | Decision | Rationale |
|---|---|---|
| OR-1 | **Orchestrator is thin; domain logic lives in subagents** | Context firewall: subagents absorb transcript bloat and return distilled artifacts. Capability grows by improving subagents, not loading the orchestrator. |
| OR-2 | **Two-plane model: online bounded loop + offline steward/consolidation** | Decouples freshness from request latency. Orchestrator reads a materialized view; offline agents pay the cost of keeping it current. |
| OR-3 | **Three-tier memory split: working / long-term / catalog view** | Different write paths + trust models. Conflating them creates drift and poisoning risk. |
| OR-4 | **Code-exec subagent as the analytics agent** | More general than fixed `analyze_*` tools; Code Mode in a sandboxed Worker with a typed API handles any coverage/performance/freshness question. |
| OR-5 | **Decision lineage replaces user-facing citations** | No end-user reading footnotes, but provenance is load-bearing for Control DO review and the learning loop's grading step. |
| OR-6 | **Every orchestration level has its own `max_loops`; Control DO owns outer gate** | Prevents recursive runaway without centralizing all stop logic in one place. |
| OR-7 | **Single observability stream; subagents yield into it via AsyncGenerator** | Inherits heartbeats, ordering, and BO rendering for free. No new channels. |
