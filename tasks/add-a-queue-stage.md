---
goal: fan a step out through Cloudflare Queues (a consumer Worker)
touches: [agents/<producer>/wrangler.template.jsonc, a new agents/<consumer>/]
acceptance: ["producer sends, consumer receives, idempotent on retry", "DLQ configured"]
---
1. The `jobs` queue exists (infra/resources.mjs). Add `queues.producers` to the producer's env and `queues.consumers` (max_batch_size, max_batch_timeout, max_retries, dead_letter_queue) to the consumer's.
2. Claim-at-enqueue: mark the row `queued` when you send; the consumer resumes idempotently (same id twice = no duplicate work).
3. Keep batch timeouts short for interactive paths (we learned: 30s batch timeouts look like "stuck").
