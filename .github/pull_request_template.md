## What & why

<!-- one paragraph; small single-purpose PRs merge fastest -->

## Checklist

- [ ] `npm run check` is green locally
- [ ] no `.env` / `.dev.vars` / keys anywhere in the diff
- [ ] if this touches `packages/*`: it's a behavioural fix, not a style pass (those get lost on re-export — see CONTRIBUTING.md)
