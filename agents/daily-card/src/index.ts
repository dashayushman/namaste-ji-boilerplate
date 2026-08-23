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
 */
import { Hono } from 'hono';
import { generateText } from 'ai';
import { buildModel, resolveModelConfig, toGenerateParams, type ModelPortEnv } from '@karkhana/agent-kernel';
import { createKVConfigStore, getConfig, GLOBAL_DEFAULTS, type GlobalConfig, type LLMProvider, type ModelParams } from '@karkhana/config';

export interface Env extends ModelPortEnv {
  CARDS: D1Database;
  CONFIG: KVNamespace;
  ENVIRONMENT: string;
  AI_GATEWAY_BASE_URL: string;
}
interface DailyCardConfig { provider: LLMProvider; model_id: string; params?: ModelParams; }
const DEFAULTS: DailyCardConfig = { provider: 'workers-ai', model_id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', params: { temperature: 0.7, max_output_tokens: 300 } };

async function writeCard(env: Env): Promise<{ id: string; title: string; line: string; provider: string; model_id: string }> {
  const store = createKVConfigStore(env.CONFIG);
  const cfg = await getConfig<DailyCardConfig>(store, 'agent:daily-card', DEFAULTS);
  const globals = await getConfig<GlobalConfig>(store, 'global:defaults', GLOBAL_DEFAULTS);
  const resolved = await resolveModelConfig(env, { provider: cfg.provider, model_id: cfg.model_id, ai_gateway_base_url: globals.ai_gateway_base_url || env.AI_GATEWAY_BASE_URL });
  const model = buildModel(resolved);
  const day = new Date().toISOString().slice(0, 10);
  const { text } = await generateText({
    model,
    ...toGenerateParams(cfg.params),
    system: 'You write one tiny good-morning card a day. Reply with JSON only: {"title": "<3 words>", "line": "<one warm, plain sentence, max 90 chars>"}',
    prompt: `Today is ${day}. Write today's card.`,
  });
  const m = text.match(/\{[\s\S]*\}/);
  let title = 'Good morning', line = text.trim().slice(0, 120);
  try { const j = JSON.parse(m?.[0] ?? '{}'); if (j.title) title = String(j.title).slice(0, 60); if (j.line) line = String(j.line).slice(0, 160); } catch {}
  const id = `card_${day}_${Math.random().toString(36).slice(2, 8)}`;
  await env.CARDS.prepare('INSERT INTO cards (id, day, title, line, provider, model_id) VALUES (?, ?, ?, ?, ?, ?)').bind(id, day, title, line, cfg.provider, cfg.model_id).run();
  return { id, title, line, provider: cfg.provider, model_id: cfg.model_id };
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
  catch (e) { return c.json({ ok: false, error: e instanceof Error ? e.message : String(e), hint: 'is CF_AI_TOKEN set and the gateway URL in KV global:defaults?' }, 500); }
});

export default {
  fetch: app.fetch,
  async scheduled(_ctrl: ScheduledController, env: Env, ctx: ExecutionContext) { ctx.waitUntil(writeCard(env).catch((e) => console.error('[daily-card] cron failed', e))); },
};
