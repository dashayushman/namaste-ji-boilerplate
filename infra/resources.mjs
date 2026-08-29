// ONE source of truth for what the Namaste Ji Boilerplate provisions, consumed by alchemy.run.ts
// (real) and by `bootstrap --dry-run` (the plan). Names are `${PROJECT_NAME}-${thing}-${stage}`.
//
// R2 and Queues are OPT-IN. Cloudflare Queues require a Workers **Paid** plan, and neither R2 nor
// the queue is bound by the example agent — so provisioning them by default made a free-plan
// bootstrap fail on something the kit never touches, with nothing in `doctor` to explain it.
// Flip PROVISION_R2 / PROVISION_QUEUE in .env when you actually need them
// (tasks/add-a-queue-stage.md walks through it).
export function resources(name, stage, opts = {}) {
  const n = (x) => `${name}-${x}-${stage}`;
  const list = [
    { kind: 'D1Database', id: 'cards-db', name: n('cards'), why: 'the example agent’s table (cards) — the catalog seed' },
    { kind: 'KVNamespace', id: 'config', name: n('config'), why: 'runtime config: model roles per agent (never in code)' },
  ];
  if (opts.r2) list.push({ kind: 'R2Bucket', id: 'content', name: n('content'), why: 'objects (images/artifacts) — opt-in via PROVISION_R2' });
  if (opts.queue) list.push({ kind: 'Queue', id: 'jobs', name: n('jobs'), why: 'async fan-out — opt-in via PROVISION_QUEUE (needs a Workers Paid plan)' });
  list.push({ kind: 'AiGateway', id: 'ai-gateway', name: n('gateway'), why: 'every model call goes through here — logs, caching, rate limits, BYOK later' });
  return list;
}

const on = (v) => /^(1|true|yes|on)$/i.test(String(v ?? ''));
/** Which optional resources this .env asks for. */
export const provisionOpts = (env) => ({ r2: on(env.PROVISION_R2), queue: on(env.PROVISION_QUEUE) });
