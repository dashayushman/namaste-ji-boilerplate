---
goal: add a new agent next to daily-card
touches: [agents/<name>/**]
acceptance: ["npm run check green", "npm run dev serves /health for the new agent", "deployed staging Worker answers /health"]
---
1. `npm run new:agent <name>` — copies the example and rewrites it: its own D1 table + migration
   (named after the agent, because migrations are tracked by filename on the shared database), its
   own binding, the wrangler template, the ModelPort call, HTTP + cron, a test. It runs
   `npm install` at the end so the new workspace is linked.
2. Edit `agents/<name>/src/index.ts` — the system prompt, the columns, the routes. Keep the
   JSON-only reply shape.
3. `npm run check` (typecheck + tests + secret scan).
4. `npm run dev --workspace=agents/<name>` — local D1 + KV, no cloud, no keys. With no AI Gateway
   configured the model call falls back to the offline stub, so `POST /run` works.
5. `npm run bootstrap` — it loops over every `agents/*`, so the new one gets its resource ids, an
   `agent:<name>` config key in KV, its secrets and a deploy. **No file to edit.** Then
   `curl <url>/health`.
6. To grow it into a real Kernel loop (tools, STM/LTM, subagents, calibrated stop):
   `docs/AGENT-KERNEL.md` + `packages/agent-kernel/src/orchestrator.ts` (`runOrchestrator`).
