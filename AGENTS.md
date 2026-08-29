# AGENTS.md — Namaste Ji Boilerplate

> **You are probably a coding agent.** This file is the front door. Read it fully; it tells you
> what this is, the one command that gets to a running app, how to verify, and where the runbooks
> are. Humans: same file, same rules.

Namaste Ji Boilerplate is a blank canvas for an **agent-operated app on Cloudflare** — the workshop Namaste Ji
([namasteji.aiwithayushman.com/build/starter](https://namasteji.aiwithayushman.com/build/starter))
was built in, generated from that monorepo and stripped to the reusable core. It ships:

- `packages/agent-kernel` — the Agent Kernel: ModelPort (any provider through the AI Gateway),
  MemoryPort (D1), STM, orchestrator loop, subagents-as-tools, Workflow runner, run reporter.
- `packages/config` — typed, KV-backed runtime config (model roles live here, never in code).
- `agents/daily-card` — the example: a tiny agent that writes one "card" a day (title + line)
  with **Workers AI by default** through the AI Gateway, stores it in D1, serves it over HTTP.
- `infra/` — Alchemy IaC (account-pinned, stage-pinned). `scripts/` — bootstrap · doctor · new:* ·
  check · smoke. `tasks/` — runbooks. `.github/workflows/check.yml` — CI.

## Invariants (do not break)
1. **Every external dependency is user-supplied.** Nothing here points at anyone's account. `.env`
   is the only place keys go; `.env*`, `.dev.vars*`, `.mcp.json`, `.alchemy/` are gitignored and
   CI fails if a secret-bearing file is tracked. The only values you MUST supply are
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; `bootstrap` generates `ALCHEMY_PASSWORD`
   itself. R2 and Queues are opt-in (`PROVISION_R2` / `PROVISION_QUEUE`) — Queues need a Workers
   **Paid** plan, and nothing in the kit binds either by default.
2. **Models are config, not code.** Provider + model per role live in KV (`packages/config`);
   default = Workers AI so the Cloudflare token alone suffices. Never hardcode a model id.
3. **All inference goes through the AI Gateway** (observable, swappable, cost-capped).
4. **Bindings are declared per environment** in `wrangler.jsonc` and never inherited.
5. **Small PRs, green `npm run check`, then `npm run smoke`.** "Done" = both green.

## The one command
```bash
cp .env.example .env        # fill CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (required)
npm install
npm run bootstrap           # provision → migrate → seed config → deploy staging → smoke → URLs
```
`bootstrap` is **idempotent** and resumable. If it stops, run `npm run doctor` — it explains
exactly what is missing (a token scope, an account id, a key) in machine-readable lines
(`OK` / `MISSING` / `FIX: …`). `npm run bootstrap -- --dry-run` prints the plan and touches nothing.

## Verification contract
- `npm run check` — typecheck every workspace + unit tests + secret scan. CI runs exactly this.
  (No linter ships with the kit; add one if you want one.)
- `npm run smoke` — hits the deployed endpoints (`/health`, `/cards`) and fails loudly.
- `npm run dev` — the local mesh: `wrangler dev` with local D1 + KV and **no cloud at all**. With
  no AI Gateway configured the example writes its card from a built-in stub, so `POST /run`,
  `GET /cards` and the cron path all work offline.

## Scaffolding (deterministic; each prints its follow-up checklist)
- `npm run new:agent <name>` — copies `agents/daily-card` and rewrites it for the new name:
  wrangler env, its own D1 table + migration, ModelPort call, HTTP + cron entry, a test. It runs
  `npm install` for you (linking the workspace) so `npm run check` passes immediately, and the
  next `npm run bootstrap` fills in ids, seeds `agent:<name>` and deploys it — no file to edit.
- (planned) `new:consumer`, `new:page`, `new:port` — not built yet.

## Runbooks — `tasks/*.md` (goal · files · commands · acceptance)
`add-an-agent.md` · `switch-a-model-role.md` · `add-a-queue-stage.md` · `deploy-prod.md`

## Which tool for which job (MCP)
Prefer the Cloudflare MCP for bindings/observability and the GitHub MCP for PRs when available
(`.mcp.json.example` — tokens inline, by the human). Otherwise `wrangler` and `gh`.

## Conventions
Conventional commits; `type/short-desc` branches; TypeScript strict; ESM; no raw hex in UI.
`CLAUDE.md` imports this file. Keep this file current — it is the contract.
