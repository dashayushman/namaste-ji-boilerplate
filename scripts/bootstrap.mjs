// bootstrap — the ONE command (AGENTS.md K-2). Idempotent and resumable:
//   doctor → provision (Alchemy) → per agent: wrangler config → migrate D1 → seed config KV →
//   secrets → deploy → smoke → print URLs.
// `--dry-run` prints the plan and touches nothing (no network). `--prod --i-know` is the only way
// to target PROJECT_STAGE=prod.
//
// EVERY step loops over `agents/*`. It used to hardcode agents/daily-card, which meant an agent
// created with `new:agent` never got its ids filled in, never got a config key, and could not be
// deployed — so the second half of this kit's promise ("then add a new agent with one command")
// was unreachable. Adding an agent now needs no edit to this file.
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { loadEnv, root, step, ok, missing, readOutputs, outputsFile, ensureAlchemyPassword } from './env.mjs';
import { resources, provisionOpts } from '../infra/resources.mjs';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const env = loadEnv();
if (env.PROJECT_STAGE === 'prod' && !(args.includes('--prod') && args.includes('--i-know'))) { missing('PROJECT_STAGE=prod', 'run `npm run bootstrap -- --prod --i-know` on purpose (tasks/deploy-prod.md)'); process.exit(1); }
const name = env.PROJECT_NAME, stage = env.PROJECT_STAGE;
const sh = (cmd, opts = {}) => { console.log(`$ ${cmd}`); if (dry) return ''; return execSync(cmd, { stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', cwd: opts.cwd ?? root, env: { ...process.env, ...env }, encoding: 'utf8' }); };

/** Every agent that carries a wrangler template — the example and anything `new:agent` made. */
const agentsDir = path.join(root, 'agents');
const AGENTS = fs.existsSync(agentsDir)
  ? fs.readdirSync(agentsDir).filter((a) => fs.existsSync(path.join(agentsDir, a, 'wrangler.template.jsonc'))).sort()
  : [];
if (!AGENTS.length) { missing('no agents found under agents/*', 'this kit ships agents/daily-card — restore it, or run `npm run new:agent <name>`'); process.exit(1); }

step(`doctor (${dry ? 'offline' : 'online'})`);
const d = spawnSync(process.execPath, [path.join(root, 'scripts/doctor.mjs'), ...(dry ? ['--offline'] : [])], { stdio: 'inherit', env: { ...process.env, ...env } });
if (d.status !== 0 && !dry) process.exit(1);

const opts = provisionOpts(env);
step(`plan — ${name} · ${stage} · ${AGENTS.length} agent(s)`);
for (const r of resources(name, stage, opts)) console.log(`  ${r.kind.padEnd(12)} ${r.name.padEnd(34)} ${r.why}`);
for (const a of AGENTS) console.log(`  ${'Worker'.padEnd(12)} ${`${name}-${a}-${stage}`.padEnd(34)} deployed from agents/${a}`);
console.log(`  ${'secrets'.padEnd(12)} CF_AI_TOKEN${env.CF_WORKERS_AI_TOKEN ? ' (from CF_WORKERS_AI_TOKEN — least privilege)' : ' (= your Cloudflare token; see .env.example for the narrower option)'} · optional OPENAI/ANTHROPIC/SARVAM keys`);
if (!opts.r2 || !opts.queue) console.log(`  ${'skipped'.padEnd(12)} ${[!opts.r2 && 'R2', !opts.queue && 'Queue (needs a Workers Paid plan)'].filter(Boolean).join(' · ')} — set PROVISION_R2 / PROVISION_QUEUE in .env to add them`);
if (dry) { console.log('\nDRY RUN: plan printed, nothing created. Re-run without --dry-run to provision.'); process.exit(0); }

ensureAlchemyPassword(env);

step('provision (Alchemy, idempotent — adopts existing names)');
sh(`npx alchemy deploy --stage ${stage}`, { cwd: path.join(root, 'infra') });
const out = readOutputs(); if (!out) { missing('infra/.outputs.json not written', 'check the Alchemy output above'); process.exit(1); }
ok(`outputs: ${Object.keys(out.resources).join(', ')}`);

// The Worker only ever needs Workers AI. Handing it the provisioning token means anything running
// inside it (or a prompt injection) could rewrite the account — so prefer a narrow token if given.
const aiToken = env.CF_WORKERS_AI_TOKEN || env.CLOUDFLARE_API_TOKEN;
if (!env.CF_WORKERS_AI_TOKEN) console.log('note     CF_AI_TOKEN will be your full provisioning token. A Workers-AI-only token in CF_WORKERS_AI_TOKEN is the least-privilege option (.env.example).');

const urls = {};
for (const agent of AGENTS) {
  const dir = path.join(agentsDir, agent);
  step(`${agent} — write wrangler.jsonc from the template`);
  const tpl = fs.readFileSync(path.join(dir, 'wrangler.template.jsonc'), 'utf8');
  const cfg = tpl.replaceAll('__NAME__', name).replaceAll('__STAGE__', stage)
    .replaceAll('__D1_NAME__', out.resources.cards_db.name).replaceAll('__D1_ID__', out.resources.cards_db.id)
    .replaceAll('__KV_ID__', out.resources.config_kv.id).replaceAll('__GATEWAY_URL__', out.resources.ai_gateway.base_url)
    .replaceAll('__JOBS_QUEUE__', out.resources.jobs_queue?.name ?? '').replaceAll('__CONTENT_R2__', out.resources.content_r2?.name ?? '');
  fs.writeFileSync(path.join(dir, 'wrangler.jsonc'), cfg);
  ok(`agents/${agent}/wrangler.jsonc written (gitignored; regenerate any time)`);

  if (fs.existsSync(path.join(dir, 'migrations'))) {
    step(`${agent} — migrate D1`);
    // every agent shares the one D1; migrations are tracked by filename, so `new:agent` renames
    // the copied migration and its table (otherwise the second agent's migration looks applied).
    const binding = (cfg.match(/"d1_databases"[\s\S]*?"binding":\s*"([A-Z0-9_]+)"/) ?? [])[1] ?? 'CARDS';
    sh(`npx wrangler d1 migrations apply ${binding} --env ${stage} --remote`, { cwd: dir });
  }

  step(`${agent} — seed config KV (model role — Workers AI by default; edit in KV, not code)`);
  const seed = { provider: 'workers-ai', model_id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', params: { temperature: 0.7, max_output_tokens: 300 } };
  const seedFile = path.join(root, 'infra/.seed-agent.json');
  fs.writeFileSync(seedFile, JSON.stringify(seed));
  sh(`npx wrangler kv key put --namespace-id ${out.resources.config_kv.id} "agent:${agent}" --path infra/.seed-agent.json --remote`);
  fs.rmSync(seedFile);

  step(`${agent} — secrets (from .env → the Worker; never written to tracked files)`);
  const putSecret = (k, v) => { if (!v) return; console.log(`$ wrangler secret put ${k} --env ${stage}`); execSync(`npx wrangler secret put ${k} --env ${stage}`, { cwd: dir, input: v, stdio: ['pipe', 'inherit', 'inherit'], env: { ...process.env, ...env } }); };
  putSecret('CF_AI_TOKEN', aiToken);
  putSecret('OPENAI_API_KEY', env.OPENAI_API_KEY); putSecret('ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY); putSecret('SARVAM_API_KEY', env.SARVAM_API_KEY);

  step(`${agent} — deploy ${stage}`);
  const outText = sh(`npx wrangler deploy --env ${stage}`, { cwd: dir, capture: true });
  process.stdout.write(outText);
  urls[agent] = (outText.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/) ?? [])[0];
}

step('seed global config');
const globals = { ai_gateway_base_url: out.resources.ai_gateway.base_url, default_provider: 'workers-ai', default_model_id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' };
fs.writeFileSync(path.join(root, 'infra/.seed-global.json'), JSON.stringify(globals));
sh(`npx wrangler kv key put --namespace-id ${out.resources.config_kv.id} "global:defaults" --path infra/.seed-global.json --remote`);
fs.rmSync(path.join(root, 'infra/.seed-global.json'));

const o2 = readOutputs();
o2.urls = { ...(o2.urls ?? {}), ...urls, dailyCard: urls['daily-card'] ?? o2.urls?.dailyCard };
fs.writeFileSync(outputsFile, JSON.stringify(o2, null, 2));

step('smoke');
spawnSync(process.execPath, [path.join(root, 'scripts/smoke.mjs')], { stdio: 'inherit', env: { ...process.env, ...env } });

const first = urls[AGENTS[0]];
console.log(`\nBOOTSTRAP: done.\n${AGENTS.map((a) => `  ${a}: ${urls[a] ?? '(see wrangler output)'}`).join('\n')}\n  run it now:  curl -X POST ${first ?? '<url>'}/run\n  next:        npm run new:agent <name>   ·   tasks/switch-a-model-role.md`);
