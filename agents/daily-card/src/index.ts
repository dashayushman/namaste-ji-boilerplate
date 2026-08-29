/**
 * daily-card — the example agent (deliberately tiny, fully real).
 *
 *   cron (01:00 UTC) or POST /run → pick the model role from KV (Workers AI by default, via YOUR
 *   AI Gateway) → ask for today's card (a 3-word title + a one-line good-morning wish, as JSON)
 *   → store it in D1 → GET /cards serves the last 30.
 *
 * Everything an agent here needs is visible in ~80 lines: config from KV (never hardcoded),
 * the ModelPort (provider-agnostic, gateway-routed), D1 storage, HTTP + cron entry points. Grow it
 * with the Kernel (runOrchestrator, tools, STM/LTM) — see docs/AGENT-KERNEL.md and tasks/.
 *
 * Offline (K-9): with `npm run dev` there is no AI Gateway and no token, so the model call is
 * replaced by a tiny deterministic stub. The point of the local mesh is to watch the pipeline move
 * — config → generate → D1 → HTTP — without an account; a 500 taught nothing.
 */
import { Hono } from 'hono';
import { generateText } from 'ai';
import { buildModel, resolveModelConfig, toGenerateParams, type ModelPortEnv } from '@namaste-ji/agent-kernel';
import { createKVConfigStore, getConfig, GLOBAL_DEFAULTS, type GlobalConfig, type LLMProvider, type ModelParams } from '@namaste-ji/config';

export interface Env extends ModelPortEnv {
  CARDS: D1Database;
  CONFIG: KVNamespace;
  ENVIRONMENT: string;
  AI_GATEWAY_BASE_URL: string;
}
interface DailyCardConfig { provider: LLMProvider; model_id: string; params?: ModelParams; }
const DEFAULTS: DailyCardConfig = { provider: 'workers-ai', model_id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', params: { temperature: 0.7, max_output_tokens: 300 } };

// The offline stub. Deterministic per day so the local database looks like a real one.
const STUB = [
  { title: 'Slow start', line: 'The kettle is on. Nothing is urgent yet.' },
  { title: 'Small light', line: 'A little sun on the wall, and that is enough for now.' },
  { title: 'Second cup', line: 'Whatever waits today, it waits until the second cup.' },
  { title: 'Open window', line: 'The street is awake. Let some of it in.' },
  { title: 'Good morning', line: 'Begin gently; the rest of the day is long enough.' },
];
const stubCard = (day: string) => STUB[[...day].reduce((a, c) => a + c.charCodeAt(0), 0) % STUB.length];

async function writeCard(env: Env): Promise<{ id: string; title: string; line: string; provider: string; model_id: string }> {
  const store = createKVConfigStore(env.CONFIG);
  const cfg = await getConfig<DailyCardConfig>(store, 'agent:daily-card', DEFAULTS);
  const globals = await getConfig<GlobalConfig>(store, 'global:defaults', GLOBAL_DEFAULTS);
  const gatewayUrl = globals.ai_gateway_base_url || env.AI_GATEWAY_BASE_URL;
  const day = new Date().toISOString().slice(0, 10);
  // provider widens to string: the offline path reports "stub", which is not an LLMProvider
  let title: string, line: string, provider: string = cfg.provider, modelId = cfg.model_id;

  if (!gatewayUrl) {
    // no gateway configured (the local mesh) — write the card ourselves rather than fail
    ({ title, line } = stubCard(day));
    provider = 'stub'; modelId = 'offline';
  } else {
    const resolved = await resolveModelConfig(env, { provider: cfg.provider, model_id: cfg.model_id, ai_gateway_base_url: gatewayUrl });
    const model = buildModel(resolved);
    const { text } = await generateText({
      model,
      ...toGenerateParams(cfg.params),
      system: 'You write one tiny good-morning card a day. Reply with JSON only: {"title": "<3 words>", "line": "<one warm, plain sentence, max 90 chars>"}',
      prompt: `Today is ${day}. Write today's card.`,
    });
    const m = text.match(/\{[\s\S]*\}/);
    title = 'Good morning'; line = text.trim().slice(0, 120);
    try { const j = JSON.parse(m?.[0] ?? '{}'); if (j.title) title = String(j.title).slice(0, 60); if (j.line) line = String(j.line).slice(0, 160); } catch {}
  }

  const id = `card_${day}_${Math.random().toString(36).slice(2, 8)}`;
  await env.CARDS.prepare('INSERT INTO cards (id, day, title, line, provider, model_id) VALUES (?, ?, ?, ?, ?, ?)').bind(id, day, title, line, provider, modelId).run();
  return { id, title, line, provider, model_id: modelId };
}

const app = new Hono<{ Bindings: Env }>();
app.get('/', (c) => c.json({ name: 'daily-card', env: c.env.ENVIRONMENT, try: ['GET /health', 'GET /cards', 'POST /run'] }));
app.get('/health', (c) => c.json({ ok: true, env: c.env.ENVIRONMENT }));
app.get('/cards', async (c) => {
  const { results } = await c.env.CARDS.prepare('SELECT id, day, title, line, provider, model_id, created_at FROM cards ORDER BY created_at DESC LIMIT 30').all();
  return c.json({ cards: results });
});
app.post('/run', async (c) => {
  try { return c.json({ ok: true, card: await writeCard(c.env) }); }
  catch (e) { return c.json({ ok: false, error: e instanceof Error ? e.message : String(e), hint: 'is CF_AI_TOKEN set and the gateway URL in KV global:defaults? (locally, with no gateway, this route uses the offline stub instead)' }, 500); }
});

export default {
  fetch: app.fetch,
  async scheduled(_ctrl: ScheduledController, env: Env, ctx: ExecutionContext) { ctx.waitUntil(writeCard(env).catch((e) => console.error('[daily-card] cron failed', e))); },
};
