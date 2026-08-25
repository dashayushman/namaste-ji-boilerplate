// Shared: read .env (no dependency), expose the kit's settings with defaults.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export function loadEnv() {
  const f = path.join(root, '.env');
  const env = { ...process.env };
  if (fs.existsSync(f)) for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  env.PROJECT_NAME = (env.PROJECT_NAME || 'my-app').toLowerCase().replace(/[^a-z0-9-]/g, '-');
  env.PROJECT_STAGE = env.PROJECT_STAGE || 'staging';
  return env;
}
export const outputsFile = path.join(root, 'infra/.outputs.json');
export const readOutputs = () => (fs.existsSync(outputsFile) ? JSON.parse(fs.readFileSync(outputsFile, 'utf8')) : null);
export const ok = (m) => console.log(`OK       ${m}`);
export const missing = (m, fix) => { console.log(`MISSING  ${m}`); if (fix) console.log(`FIX:     ${fix}`); };
export const step = (m) => console.log(`\n▶ ${m}`);
