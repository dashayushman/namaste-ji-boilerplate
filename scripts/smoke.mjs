// smoke — hit the deployed endpoints and fail loudly. URL from infra outputs or --url.
import { readOutputs, loadEnv } from './env.mjs';
const env = loadEnv();
const arg = process.argv.find((a) => a.startsWith('--url='))?.slice(6);
const out = readOutputs();
const base = arg ?? out?.urls?.dailyCard;
if (!base) { console.error('SMOKE: no URL — run bootstrap first or pass --url=https://…'); process.exit(1); }
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.text() }; };
const h = await get('/health'); console.log(`GET /health → ${h.status} ${h.body.slice(0, 80)}`);
const c = await get('/cards'); console.log(`GET /cards → ${c.status} ${c.body.slice(0, 120)}`);
if (h.status !== 200 || c.status !== 200) { console.error('SMOKE: failed'); process.exit(1); }
console.log('SMOKE: green.');
