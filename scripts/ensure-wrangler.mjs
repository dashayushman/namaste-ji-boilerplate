// If an agent has no wrangler.jsonc yet (fresh clone, before bootstrap), materialise it from the
// template so `npm run dev` works locally with no cloud at all.
import fs from 'node:fs'; import path from 'node:path'; import { root, loadEnv } from './env.mjs';
const agent = process.argv[2]; const dir = path.join(root, 'agents', agent);
const env = loadEnv();
if (!fs.existsSync(path.join(dir, 'wrangler.jsonc'))) {
  const tpl = fs.readFileSync(path.join(dir, 'wrangler.template.jsonc'), 'utf8');
  fs.writeFileSync(path.join(dir, 'wrangler.jsonc'), tpl.replaceAll('__NAME__', env.KARKHANA_NAME).replaceAll('__STAGE__', env.KARKHANA_STAGE));
  console.log(`wrote ${agent}/wrangler.jsonc from the template (local env ready; staging ids filled by bootstrap)`);
}
