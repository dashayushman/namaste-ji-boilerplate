// doctor — explains exactly what is missing, in agent-readable lines (OK / MISSING / FIX:).
import { loadEnv, ok, missing, readOutputs } from './env.mjs';
import { provisionOpts } from '../infra/resources.mjs';
import { execSync } from 'node:child_process';
const env = loadEnv();
let bad = 0;
const need = (k, fix) => { if (env[k]) ok(`${k} set`); else { missing(`${k} is empty`, fix); bad++; } };
need('CLOUDFLARE_API_TOKEN', 'create a scoped token (see .env.example) and put it in .env');
need('CLOUDFLARE_ACCOUNT_ID', 'Cloudflare dashboard → Workers & Pages → Account ID → .env');
// NOT blocking: bootstrap mints one into .env on first run. README and AGENTS.md promise the
// Cloudflare token and account id are the only values you must supply — this keeps that true.
console.log(env.ALCHEMY_PASSWORD ? 'OK       ALCHEMY_PASSWORD set (encrypts Alchemy state; keep it stable)' : 'info     ALCHEMY_PASSWORD not set — bootstrap will generate one into .env');
if (!/^[a-z0-9-]{2,30}$/.test(env.PROJECT_NAME)) { missing(`PROJECT_NAME "${env.PROJECT_NAME}" must be lowercase letters/digits/dashes`, 'set PROJECT_NAME=my-app in .env'); bad++; } else ok(`PROJECT_NAME=${env.PROJECT_NAME} · stage=${env.PROJECT_STAGE}`);
// token scopes (best-effort, online)
if (env.CLOUDFLARE_API_TOKEN && !process.argv.includes('--offline')) {
  try {
    const r = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } });
    const j = await r.json();
    if (j.success && j.result?.status === 'active') ok('Cloudflare token is active'); else { missing('Cloudflare token did not verify', 'regenerate the token; check it is an API token, not a global key'); bad++; }
    if (env.CLOUDFLARE_ACCOUNT_ID) {
      const a = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`, { headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } });
      const aj = await a.json();
      if (aj.success) ok(`account reachable: ${aj.result?.name ?? env.CLOUDFLARE_ACCOUNT_ID}`); else { missing('token cannot read the account', 'add Account Settings:Read to the token, and check CLOUDFLARE_ACCOUNT_ID'); bad++; }
    }
  } catch (e) { missing(`network check failed: ${e.message}`, 'retry with network, or run `doctor --offline`'); }
}
for (const [k, what] of [['OPENAI_API_KEY', 'OpenAI roles'], ['ANTHROPIC_API_KEY', 'Anthropic roles'], ['SARVAM_API_KEY', 'Sarvam roles'], ['LANGFUSE_SECRET_KEY', 'Langfuse tracing/prompts'], ['TAVILY_API_KEY', 'web research tool']]) console.log(`${env[k] ? 'OK      ' : 'optional'} ${k} ${env[k] ? 'set' : 'not set'} — ${what}`);
try { ok(`node ${process.version} · wrangler ${execSync('npx wrangler --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').pop()}`); } catch { missing('wrangler not runnable', 'npm install'); bad++; }
const opts = provisionOpts(env);
console.log(`info     optional resources: R2 ${opts.r2 ? 'ON' : 'off'} · Queues ${opts.queue ? 'ON' : 'off'} (PROVISION_R2 / PROVISION_QUEUE in .env)`);
if (opts.queue) console.log('info     Cloudflare Queues need a Workers PAID plan — on the free plan provisioning fails here. Unset PROVISION_QUEUE to skip it.');
console.log(env.CF_WORKERS_AI_TOKEN
  ? 'OK       CF_WORKERS_AI_TOKEN set — the Worker gets a Workers-AI-only token (least privilege)'
  : 'info     CF_WORKERS_AI_TOKEN not set — the Worker will receive your full provisioning token as CF_AI_TOKEN. A Workers-AI-only token is the safer option (.env.example).');
const out = readOutputs();
console.log(out ? `OK       infra outputs present (${Object.keys(out.resources ?? {}).join(', ')})` : 'info     infra not provisioned yet — `npm run bootstrap` will do it');
console.log(bad ? `\nDOCTOR: ${bad} blocking issue(s).` : '\nDOCTOR: ready — run `npm run bootstrap`.');
process.exit(bad ? 1 : 0);
