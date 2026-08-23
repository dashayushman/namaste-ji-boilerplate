// bootstrap — the ONE command (AGENTS.md K-2). Idempotent and resumable:
//   doctor → provision (Alchemy) → write wrangler config → migrate D1 → seed config KV → secrets →
//   deploy staging → smoke → print URLs.
// `--dry-run` prints the plan and touches nothing (no network). `--prod --i-know` is the only way
// to target KARKHANA_STAGE=prod.
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { loadEnv, root, step, ok, missing, readOutputs, outputsFile } from './env.mjs';
import { resources } from '../infra/resources.mjs';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const env = loadEnv();
if (env.KARKHANA_STAGE === 'prod' && !(args.includes('--prod') && args.includes('--i-know'))) { missing('KARKHANA_STAGE=prod', 'run `npm run bootstrap -- --prod --i-know` on purpose (tasks/deploy-prod.md)'); process.exit(1); }
const name = env.KARKHANA_NAME, stage = env.KARKHANA_STAGE;
const sh = (cmd, opts = {}) => { console.log(`$ ${cmd}`); if (dry) return ''; return execSync(cmd, { stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', cwd: opts.cwd ?? root, env: { ...process.env, ...env }, encoding: 'utf8' }); };

step(`doctor (${dry ? 'offline' : 'online'})`);
const d = spawnSync(process.execPath, [path.join(root, 'scripts/doctor.mjs'), ...(dry ? ['--offline'] : [])], { stdio: 'inherit', env: { ...process.env, ...env } });
if (d.status !== 0 && !dry) process.exit(1);

step(`plan — ${name} · ${stage}`);
for (const r of resources(name, stage)) console.log(`  ${r.kind.padEnd(12)} ${r.name.padEnd(34)} ${r.why}`);
console.log(`  Worker       ${name}-daily-card-${stage}`.padEnd(50) + ' the example agent (cron 01:00 UTC + HTTP)');
console.log(`  secrets      CF_AI_TOKEN (= your Cloudflare token, for Workers AI) · optional OPENAI/ANTHROPIC/SARVAM keys`);
if (dry) { console.log('\nDRY RUN: plan printed, nothing created. Re-run without --dry-run to provision.'); process.exit(0); }

step('provision (Alchemy, idempotent — adopts existing names)');
sh(`npx alchemy deploy --stage ${stage}`, { cwd: path.join(root, 'infra') });
const out = readOutputs(); if (!out) { missing('infra/.outputs.json not written', 'check the Alchemy output above'); process.exit(1); }
ok(`outputs: ${Object.keys(out.resources).join(', ')}`);

step('write agents/daily-card/wrangler.jsonc from the template');
const tpl = fs.readFileSync(path.join(root, 'agents/daily-card/wrangler.template.jsonc'), 'utf8');
const cfg = tpl.replaceAll('__NAME__', name).replaceAll('__STAGE__', stage)
  .replaceAll('__CARDS_D1_NAME__', out.resources.cards_db.name).replaceAll('__CARDS_D1_ID__', out.resources.cards_db.id)
  .replaceAll('__CONFIG_KV_ID__', out.resources.config_kv.id).replaceAll('__AI_GATEWAY_BASE_URL__', out.resources.ai_gateway.base_url)
  .replaceAll('__JOBS_QUEUE__', out.resources.jobs_queue.name).replaceAll('__CONTENT_R2__', out.resources.content_r2.name);
fs.writeFileSync(path.join(root, 'agents/daily-card/wrangler.jsonc'), cfg); ok('wrangler.jsonc written (gitignored; regenerate any time)');

step('migrate D1');
sh(`npx wrangler d1 migrations apply CARDS --env ${stage} --remote`, { cwd: path.join(root, 'agents/daily-card') });

step('seed config KV (model roles — Workers AI by default; edit in KV, not code)');
const seed = { provider: 'workers-ai', model_id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', params: { temperature: 0.7, max_output_tokens: 300 } };
const globals = { ai_gateway_base_url: out.resources.ai_gateway.base_url, default_provider: 'workers-ai', default_model_id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' };
fs.writeFileSync(path.join(root, 'infra/.seed-agent.json'), JSON.stringify(seed)); fs.writeFileSync(path.join(root, 'infra/.seed-global.json'), JSON.stringify(globals));
sh(`npx wrangler kv key put --namespace-id ${out.resources.config_kv.id} "agent:daily-card" --path infra/.seed-agent.json --remote`);
sh(`npx wrangler kv key put --namespace-id ${out.resources.config_kv.id} "global:defaults" --path infra/.seed-global.json --remote`);
fs.rmSync(path.join(root, 'infra/.seed-agent.json')); fs.rmSync(path.join(root, 'infra/.seed-global.json'));

step('secrets (from .env → the Worker; never written to tracked files)');
const putSecret = (k, v) => { if (!v) return; console.log(`$ wrangler secret put ${k} --env ${stage}`); execSync(`npx wrangler secret put ${k} --env ${stage}`, { cwd: path.join(root, 'agents/daily-card'), input: v, stdio: ['pipe', 'inherit', 'inherit'], env: { ...process.env, ...env } }); };
putSecret('CF_AI_TOKEN', env.CLOUDFLARE_API_TOKEN);
putSecret('OPENAI_API_KEY', env.OPENAI_API_KEY); putSecret('ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY); putSecret('SARVAM_API_KEY', env.SARVAM_API_KEY);

step('deploy staging');
const outText = sh(`npx wrangler deploy --env ${stage}`, { cwd: path.join(root, 'agents/daily-card'), capture: true });
process.stdout.write(outText);
const url = (outText.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/) ?? [])[0];
const o2 = readOutputs(); o2.urls = { ...(o2.urls ?? {}), dailyCard: url ?? o2.urls?.dailyCard }; fs.writeFileSync(outputsFile, JSON.stringify(o2, null, 2));

step('smoke');
spawnSync(process.execPath, [path.join(root, 'scripts/smoke.mjs')], { stdio: 'inherit', env: { ...process.env, ...env } });

console.log(`\nBOOTSTRAP: done.\n  daily-card: ${url ?? '(see wrangler output)'}\n  run it now:  curl -X POST ${url ?? '<url>'}/run\n  see cards:   ${url ?? '<url>'}/cards\n  next:        npm run new:agent <name>   ·   tasks/switch-a-model-role.md`);
