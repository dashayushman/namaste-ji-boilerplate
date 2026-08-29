# Security policy

## Reporting

If you find a vulnerability — in the scripts, the example agent, the infrastructure defaults, or
anything that could leak a user's Cloudflare credentials — please report it privately:

- **GitHub**: use [private vulnerability reporting](../../security/advisories/new) on this repo
  ("Report a vulnerability" under the Security tab).

Please don't open a public issue for anything sensitive. You'll get an acknowledgement within a
few days; fixes ship as ordinary releases with credit if you want it.

## Scope worth knowing about

This kit's security posture is deliberately simple and worth understanding before you deploy:

- **Your `.env` is the only place credentials live.** Nothing in the repo phones home; the kit
  owns no accounts. CI fails if a secret-bearing file is ever tracked.
- **The Worker receives an AI token.** By default that is your provisioning token (documented in
  `.env.example`); setting `CF_WORKERS_AI_TOKEN` to a Workers-AI-only token is the least-privilege
  option and the one we recommend.
- **`bootstrap` refuses prod without `--prod --i-know`**, and Alchemy is pinned to the account and
  stage in your `.env` so it cannot wander into another environment.
