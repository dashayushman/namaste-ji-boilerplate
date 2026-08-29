# Contributing

Thanks for looking under the hood. Two things to know before you open anything:

## This repo is generated

The Namaste Ji Boilerplate is exported from a private monorepo by an allow-listed script
(`EXPORTED-FROM.md` has the details). That has one practical consequence: **a change merged here
must also land in the upstream source, or the next export will silently undo it.** The maintainer
handles that — you don't need access to the upstream.

So the flow is:

1. **Bugs and ideas → open an issue.** Small reproductions beat long descriptions. If `bootstrap`,
   `doctor`, `check` or `new:agent` broke, paste the command and its full output — those scripts
   are designed to be quotable.
2. **Fixes → open a PR against `main`.** Keep it small and single-purpose. CI must be green
   (`npm run check`, the scaffold probe, and the dry-run plan). The maintainer merges it here
   *and* folds it into the upstream source so the next export keeps it, crediting you in the
   commit.
3. **Don't hand-edit `packages/agent-kernel` or `packages/config` for style** — they are copied
   verbatim from the upstream. Behavioural fixes are welcome; cosmetic churn will be lost.

## Ground rules

- `npm run check` green is the definition of done; CI runs exactly it.
- Never commit `.env`, `.dev.vars`, `.mcp.json`, or anything with a key in it. CI fails the build
  if a secret-bearing file is tracked — that check protects you too.
- Conventional commits (`fix:`, `feat:`, `docs:` …), `type/short-desc` branches.
- Be kind and assume good faith — the standard [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/)
  applies to all project spaces.

## Security

Found something sensitive? Please **don't** open a public issue — see [SECURITY.md](./SECURITY.md).
