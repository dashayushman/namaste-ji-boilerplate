// check — typecheck every workspace + unit tests + secret scan. CI runs exactly this.
import { execSync } from 'node:child_process';
import { root } from './env.mjs';
const run = (cmd) => { console.log(`\n$ ${cmd}`); execSync(cmd, { stdio: 'inherit', cwd: root }); };
run('npm run typecheck --workspaces --if-present');
run('npm test --workspaces --if-present');
// secret scan: no tracked file may match these names; no tracked file may contain a known key shape.
const tracked = execSync('git ls-files', { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
const forbidden = tracked.filter((f) => /(^|\/)(\.env(\..*)?|\.dev\.vars(\..*)?|\.mcp\.json|.*\.pem|.*\.key)$/.test(f) && !/\.example$/.test(f));
if (forbidden.length) { console.error('SECRET SCAN: secret-bearing files are tracked:', forbidden); process.exit(1); }
const { readFileSync } = await import('node:fs');
const shapes = /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC )?PRIVATE KEY-----)/;
const leaks = tracked.filter((f) => /\.(ts|js|mjs|json|jsonc|md|yml|yaml|toml|txt)$/.test(f)).filter((f) => { try { return shapes.test(readFileSync(`${root}/${f}`, 'utf8')); } catch { return false; } });
if (leaks.length) { console.error('SECRET SCAN: key-shaped strings in:', leaks); process.exit(1); }
console.log('\nCHECK: green.');
