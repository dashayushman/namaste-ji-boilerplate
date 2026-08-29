// check — typecheck every workspace + unit tests + secret scan. CI runs exactly this.
// (It does NOT lint: there is no linter in the kit. AGENTS.md used to claim one, which is the
// kind of small lie that makes an agent trust the rest of the file less.)
import { execSync } from 'node:child_process';
import { root } from './env.mjs';
const run = (cmd) => { console.log(`\n$ ${cmd}`); execSync(cmd, { stdio: 'inherit', cwd: root }); };
run('npm run typecheck --workspaces --if-present');
run('npm test --workspaces --if-present');
// secret scan: no tracked file may match these names; no tracked file may contain a known key shape.
// the scan needs git; outside a repo (a plain download, a container copy) say so and stop rather
// than dying on an unhandled spawn error
let tracked;
try { tracked = execSync('git ls-files', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean); }
catch { console.log('\nSECRET SCAN: skipped — not a git repository (run `git init` to enable it).\nCHECK: green (typecheck + tests).'); process.exit(0); }
const forbidden = tracked.filter((f) => /(^|\/)(\.env(\..*)?|\.dev\.vars(\..*)?|\.mcp\.json|.*\.pem|.*\.key)$/.test(f) && !/\.example$/.test(f));
if (forbidden.length) { console.error('SECRET SCAN: secret-bearing files are tracked:', forbidden); process.exit(1); }
const { readFileSync } = await import('node:fs');
const shapes = /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC )?PRIVATE KEY-----)/;
const leaks = tracked.filter((f) => /\.(ts|js|mjs|json|jsonc|md|yml|yaml|toml|txt)$/.test(f)).filter((f) => { try { return shapes.test(readFileSync(`${root}/${f}`, 'utf8')); } catch { return false; } });
if (leaks.length) { console.error('SECRET SCAN: key-shaped strings in:', leaks); process.exit(1); }
console.log('\nCHECK: green.');
