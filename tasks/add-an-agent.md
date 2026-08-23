---
goal: add a new agent next to daily-card
touches: [agents/<name>/**, scripts/bootstrap.mjs]
acceptance: ["npm run check green", "npm run dev serves /health for the new agent", "deployed staging Worker answers /health"]
---
1. `npm run new:agent <name>` — scaffolds from the example (wrangler template, migration, ModelPort call, HTTP + cron, a test).
2. Rename the table/migration; write the system prompt; keep the JSON-only reply shape (see src/index.ts).
3. Model roles: add `"agent:<name>"` to the KV seed in `scripts/bootstrap.mjs` (or `wrangler kv key put`). Never hardcode a model id.
4. `npm run check` → `npm run dev` (local D1/KV, no cloud) → `cd agents/<name> && npx wrangler deploy --env staging` → `curl <url>/health`.
5. To grow it into a real Kernel loop (tools, STM/LTM, subagents, calibrated stop): `docs/AGENT-KERNEL.md` + `packages/agent-kernel/src/orchestrator.ts` (`runOrchestrator`).
