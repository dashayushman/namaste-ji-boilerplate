// new:agent <name> — scaffold a new agent from the example (deterministic), then print the checklist.
import fs from 'node:fs'; import path from 'node:path'; import { root } from './env.mjs';
const name = (process.argv[2] ?? '').toLowerCase();
if (!/^[a-z][a-z0-9-]{1,30}$/.test(name)) { console.error('usage: npm run new:agent <kebab-name>'); process.exit(1); }
const src = path.join(root, 'agents/daily-card'), dst = path.join(root, 'agents', name);
if (fs.existsSync(dst)) { console.error(`agents/${name} already exists`); process.exit(1); }
const copy = (from, to) => {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (['node_modules', 'wrangler.jsonc', '.wrangler'].includes(e.name)) continue;
    const f = path.join(from, e.name), t = path.join(to, e.name.replaceAll('daily-card', name));
    if (e.isDirectory()) { fs.mkdirSync(t, { recursive: true }); copy(f, t); }
    else fs.writeFileSync(t, fs.readFileSync(f, 'utf8').replaceAll('daily-card', name).replaceAll('daily_card', name.replaceAll('-', '_')).replaceAll('Daily Card', name.replace(/(^|-)(\w)/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase())));
  }
};
fs.mkdirSync(dst, { recursive: true }); copy(src, dst);
// Add a CI matrix entry + a bootstrap deploy line marker (kept explicit so humans see it in the diff).
console.log(`created agents/${name} from the example.\n\nNEXT (checklist):\n  1. rename the table + migration in agents/${name}/migrations/0001_*.sql (it still says "cards")\n  2. edit src/index.ts — the system prompt, the table, the routes\n  3. add "agent:${name}" config to bootstrap's seed step (scripts/bootstrap.mjs) or put it in KV by hand\n  4. npm run check   ·   npm --workspace=agents/${name} run dev   ·   deploy: cd agents/${name} && npx wrangler deploy --env staging\n  5. open a PR: feat(${name}): scaffold`);
