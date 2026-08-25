# Namaste Ji Boilerplate · कारख़ाना

**An agent-operated app on Cloudflare — a workshop built for coding agents.**

Give a coding agent this repo and a `.env` with the keys *you* supply, and in one session it reaches a
provisioned, deployed, running app on Cloudflare — then adds a new agent with one command.

```bash
git clone https://github.com/dashayushman/namaste-ji-boilerplate my-app && cd my-app
cp .env.example .env      # add YOUR Cloudflare token + account id — the only required keys
npm install
npm run bootstrap         # provision · migrate · seed · deploy · smoke → prints the URLs
npm run new:agent greeting-writer
```

Start at **[AGENTS.md](./AGENTS.md)** — it is written for agents first (humans second) and is the contract.

Namaste Ji Boilerplate is generated from the [Namaste Ji](https://namasteji.aiwithayushman.com) monorepo (an
allow-listed export — the Agent Kernel, the config loader, the contracts, RBAC, the IaC, CI, and a tiny
example pipeline) by the founder, [Ayushman Dash](https://aiwithayushman.com). Read how the real thing is
built at [namasteji.aiwithayushman.com/build](https://namasteji.aiwithayushman.com/build).

**Status: v0.** The kernel, config, infra, bootstrap/doctor/check/smoke, the `daily-card` example and
`new:agent` work; the console shell, `new:consumer`/`new:page`/`new:port` and the weekly cloud e2e are
next. No account is owned by this kit; CI proves `check` + `bootstrap --dry-run` without one.

MIT © Ayushman Dash
