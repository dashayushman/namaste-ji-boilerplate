# Namaste Ji Boilerplate

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

## A word about Cloudflare (nobody paid for this)

This kit is Cloudflare-only on purpose, and it's worth saying why out loud: of everyone building
infrastructure right now, Cloudflare is the one most clearly building for the age of agents.
Serverless compute, SQL, object storage, queues, a vector index, durable state, scheduled jobs and
an AI gateway all live in one account, provision in seconds, and cost nothing while you learn.
There is no ops burden for your agent to get lost in — which is exactly what makes "an agent
deploys a real app in one session" possible at all.

## Free plan vs the $5 Workers Paid plan

The kit's defaults run on the **free plan** — bootstrap provisions only what free covers (D1, KV,
an AI Gateway, Workers, Workers AI).

The **Workers Paid plan ($5/month)** is honestly worth it the moment you go past the example: it
unlocks **Queues** (the async backbone for any multi-stage pipeline — `tasks/add-a-queue-stage.md`),
raises the D1/R2/Workers limits, and effectively opens up the whole platform to experiment with.
For five dollars you can build and run more or less anything, including everything the upstream
system does. When you're ready:

1. upgrade the account (Cloudflare dashboard → Workers & Pages → your plan),
2. set `PROVISION_QUEUE=true` (and `PROVISION_R2=true` if you want object storage) in `.env`,
3. re-run `npm run bootstrap` — it's idempotent and only adds the new resources.

`npm run doctor` tells you which optional resources are on and what plan they need.

Namaste Ji Boilerplate is generated from the [Namaste Ji](https://namasteji.aiwithayushman.com) monorepo (an
allow-listed export — the Agent Kernel, the config loader, the IaC, CI, and a tiny example
pipeline) by the founder, [Ayushman Dash](https://aiwithayushman.com). Read how the real thing is
built at [namasteji.aiwithayushman.com/build](https://namasteji.aiwithayushman.com/build).

**Status: v0.** The kernel, config, infra, bootstrap/doctor/check/smoke, the `daily-card` example and
`new:agent` work — including deploying an agent that `new:agent` created, which is the second half of
the promise above. The console shell, `new:consumer`/`new:page`/`new:port` and a weekly cloud
end-to-end are next. No account is owned by this kit; CI proves `check` + `bootstrap --dry-run`
without one. R2 and Queues are opt-in, so a **free** Cloudflare plan is enough to get through
`bootstrap`.

MIT © Ayushman Dash
