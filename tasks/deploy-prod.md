---
goal: a second, isolated stage (prod) — same kit, different names, deliberate
touches: [.env (PROJECT_STAGE=prod), nothing else]
acceptance: ["prod resources are `<name>-*-prod`", "staging untouched"]
---
1. Copy `.env` → change `PROJECT_STAGE=prod`. Stages are pinned per run; a prod run cannot see staging's Alchemy scope.
2. `npm run bootstrap -- --prod --i-know` (doctor refuses prod without the flags).
3. Prefer a GitHub Environment gate for the deploy step in CI; keep staging auto-on-merge.
