# AGENTS.md — Karkhana (कारख़ाना · the workshop)

> **You are probably a coding agent.** This file is the front door. Read it fully; it tells you
> what this is, the one command that gets to a running app, how to verify, and where the runbooks
> are. Humans: same file, same rules.

Karkhana is a blank canvas for an **agent-operated app on Cloudflare** — the workshop Karkhana
([namasteji.aiwithayushman.com/build/starter](https://namasteji.aiwithayushman.com/build/starter))
was built in, generated from that monorepo and stripped to the reusable core. It ships:

- `packages/agent-kernel` — the Agent Kernel: ModelPort (any provider through the AI Gateway),
  MemoryPort (D1), STM, orchestrator loop, subagents-as-tools, Workflow runner, run reporter.
- `packages/config` — typed, KV-backed runtime config (model roles live here, never in code).
- `packages/shared` — versioned Zod contracts. `packages/rbac` — RBAC middleware + permission enum.
- `agents/daily-card` — the example: a tiny agent that writes one "card" a day (title + line)
  with **Workers AI by default** through the AI Gateway, stores it in D1, serves it over HTTP.
- `infra/` — Alchemy IaC (account-pinned, stage-pinned). `scripts/` — bootstrap · doctor · new:* ·
  check · smoke. `tasks/` — runbooks. `.github/workflows/check.yml` — CI.

## Invariants (do not break)
1. **Every external dependency is user-supplied.** Nothing here points at anyone's account. `.env`
   is the only place keys go; `.env*`, `.dev.vars*`, `.mcp.json`, `.alchemy/` are gitignored and
   CI fails if a secret-bearing file is tracked.
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
- `npm run smoke` — hits the deployed endpoints (`/health`, `/cards`) and fails loudly.
- `npm run dev` — the local mesh (`wrangler dev` for each worker with local D1/KV, stub model).

## Scaffolding (deterministic; each prints its follow-up checklist)
- `npm run new:agent <name>` — a new agent from `templates/agent`: wrangler env, D1 migration,
  ModelPort call, HTTP + cron entry, CI job, a test.
- (planned) `new:consumer`, `new:page`, `new:port` — see `tasks/`.

## Runbooks — `tasks/*.md` (goal · files · commands · acceptance)
`add-an-agent.md` · `switch-a-model-role.md` · `add-a-queue-stage.md` · `deploy-prod.md`

## Which tool for which job (MCP)
Prefer the Cloudflare MCP for bindings/observability and the GitHub MCP for PRs when available
(`.mcp.json.example` — tokens inline, by the human). Otherwise `wrangler` and `gh`.

## Conventions
Conventional commits; `type/short-desc` branches; TypeScript strict; ESM; no raw hex in UI.
`CLAUDE.md` imports this file. Keep this file current — it is the contract.
