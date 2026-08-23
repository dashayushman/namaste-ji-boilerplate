/**
 * Karkhana — YOUR Cloudflare substrate as TypeScript (Alchemy). One stage per run, pinned.
 * Provisions the BACKING RESOURCES only; Workers are deployed by `wrangler deploy` (bootstrap).
 *
 * Safety: account and stage are pinned from .env (CLOUDFLARE_ACCOUNT_ID, KARKHANA_STAGE) so a stray
 * `--stage` can never point Alchemy at another environment's resources and destroy them.
 */
import fs from 'node:fs';
import alchemy from 'alchemy';
import { D1Database, KVNamespace, R2Bucket, Queue, AiGateway } from 'alchemy/cloudflare';
import { resources } from './resources.mjs';

const name = (process.env.KARKHANA_NAME ?? 'karkhana').toLowerCase();
const stage = process.env.KARKHANA_STAGE ?? 'staging';
if (!process.env.CLOUDFLARE_ACCOUNT_ID) throw new Error('CLOUDFLARE_ACCOUNT_ID is required (pin it in .env) — refusing to guess an account');
if (!process.env.ALCHEMY_PASSWORD) throw new Error('ALCHEMY_PASSWORD is required (.env) — it encrypts Alchemy state');

const app = await alchemy(name, { stage, password: process.env.ALCHEMY_PASSWORD });
const spec = resources(name, stage);
const byId = Object.fromEntries(spec.map((r) => [r.id, r]));

export const cardsDb = await D1Database('cards-db', { name: byId['cards-db'].name, adopt: true });
export const config = await KVNamespace('config', { title: byId['config'].name, adopt: true });
export const content = await R2Bucket('content', { name: byId['content'].name, adopt: true });
export const jobs = await Queue('jobs', { name: byId['jobs'].name, adopt: true });
export const gateway = await AiGateway('ai-gateway', { gatewayName: byId['ai-gateway'].name, collectLogs: true, authentication: false });

const outputs = {
  name, stage, account_id: process.env.CLOUDFLARE_ACCOUNT_ID,
  resources: {
    cards_db: { name: cardsDb.name, id: cardsDb.id },
    config_kv: { name: config.title, id: config.namespaceId },
    content_r2: { name: content.name },
    jobs_queue: { name: jobs.name },
    ai_gateway: { name: gateway.gatewayName, base_url: `https://gateway.ai.cloudflare.com/v1/${process.env.CLOUDFLARE_ACCOUNT_ID}/${gateway.gatewayName}` },
  },
};
fs.writeFileSync(new URL('./.outputs.json', import.meta.url), JSON.stringify(outputs, null, 2));
console.log('Provisioned:', JSON.stringify(outputs.resources, null, 2));
await app.finalize();
