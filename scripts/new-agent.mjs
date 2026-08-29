// new:agent <name> — scaffold a new agent from the example (deterministic), wire it into the
// workspace, and print the checklist.
//
// Two things this used to leave to the human, both of which broke the kit's own promise:
//   1. the new workspace was never linked, so the very next instructed step (`npm run check`)
//      failed with TS2688 "cannot find type definition file for @cloudflare/workers-types";
//   2. the copied migration and table were still called `cards` — and D1 tracks migrations by
//      filename, so on a shared database the second agent's migration silently looked applied.
// Both are handled here now: the table, the binding and the migration file take the agent's name,
// and `npm install` runs at the end.
import fs from 'node:fs'; import path from 'node:path'; import { execSync } from 'node:child_process'; import { root } from './env.mjs';

const name = (process.argv[2] ?? '').toLowerCase();
if (!/^[a-z][a-z0-9-]{1,30}$/.test(name)) { console.error('usage: npm run new:agent <kebab-name>'); process.exit(1); }
const snake = name.replaceAll('-', '_');            // table name
const SNAKE = snake.toUpperCase();                  // binding name
const title = name.replace(/(^|-)(\w)/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase());

const src = path.join(root, 'agents/daily-card'), dst = path.join(root, 'agents', name);
if (fs.existsSync(dst)) { console.error(`agents/${name} already exists`); process.exit(1); }

const rename = (s) => s
  .replaceAll('daily-card', name).replaceAll('daily_card', snake).replaceAll('Daily Card', title)
  // the example's table/binding become this agent's own — they share one D1
  .replaceAll('CARDS', SNAKE).replaceAll('cards', snake);
const renameFile = (f) => f.replaceAll('daily-card', name).replaceAll('cards', snake);

const copy = (from, to) => {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (['node_modules', 'wrangler.jsonc', '.wrangler'].includes(e.name)) continue;
    const f = path.join(from, e.name), t = path.join(to, renameFile(e.name));
    if (e.isDirectory()) { fs.mkdirSync(t, { recursive: true }); copy(f, t); }
    else fs.writeFileSync(t, rename(fs.readFileSync(f, 'utf8')));
  }
};
fs.mkdirSync(dst, { recursive: true }); copy(src, dst);

// link the new workspace so `npm run check` works immediately
console.log('$ npm install (linking the new workspace)');
try { execSync('npm install --no-audit --no-fund', { cwd: root, stdio: 'inherit' }); }
catch { console.log('npm install failed — run it yourself before `npm run check`.'); }

console.log(`
created agents/${name} from the example — table \`${snake}\`, binding \`${SNAKE}\`, route /${snake}.

NEXT (checklist):
  1. edit agents/${name}/src/index.ts — the system prompt, the columns, the routes
  2. npm run check                      (typecheck + tests + secret scan)
  3. npm run dev --workspace=agents/${name}     (local: D1 + KV + the offline model stub)
  4. npm run bootstrap                  (provisions nothing new; fills in ids, seeds \`agent:${name}\`, deploys it)
  5. open a PR: feat(${name}): scaffold`);
