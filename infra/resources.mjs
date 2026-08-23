// ONE source of truth for what Karkhana provisions, consumed by alchemy.run.ts (real) and by
// `bootstrap --dry-run` (the plan). Names are `${KARKHANA_NAME}-${thing}-${stage}`.
export function resources(name, stage) {
  const n = (x) => `${name}-${x}-${stage}`;
  return [
    { kind: 'D1Database', id: 'cards-db', name: n('cards'), why: 'the example agent’s table (cards) — the catalog seed' },
    { kind: 'KVNamespace', id: 'config', name: n('config'), why: 'runtime config: model roles per agent (never in code)' },
    { kind: 'R2Bucket', id: 'content', name: n('content'), why: 'objects (images/artifacts) — empty until you store something' },
    { kind: 'Queue', id: 'jobs', name: n('jobs'), why: 'async backbone for fan-out stages (tasks/add-a-queue-stage.md)' },
    { kind: 'AiGateway', id: 'ai-gateway', name: n('gateway'), why: 'every model call goes through here — logs, caching, rate limits, BYOK later' },
  ];
}
