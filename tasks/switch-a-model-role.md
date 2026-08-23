---
goal: move an agent's model role to another provider without a deploy
touches: [KV config only]
acceptance: ["next run uses the new provider (check the Worker log / gateway logs)"]
---
1. Provider key present? `.env` → bootstrap puts `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `SARVAM_API_KEY` as Worker secrets. Re-run `npm run bootstrap` after adding one (idempotent).
2. Edit the KV key `agent:<name>` in your config namespace, e.g. `{"provider":"openai","model_id":"gpt-5.4-mini"}` or `{"provider":"sarvam","model_id":"sarvam-105b"}` (text-only).
   `npx wrangler kv key put --namespace-id <CONFIG_KV_ID> "agent:daily-card" '{"provider":"openai","model_id":"gpt-5.4-mini"}' --remote`
3. `curl -X POST <url>/run` — the stored card records `provider` + `model_id`. Nothing redeployed.
Why: models are config, not code (AGENTS.md invariant 2); every call still goes through your AI Gateway.
