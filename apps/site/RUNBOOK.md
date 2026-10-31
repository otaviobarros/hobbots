# Site runbook

One-time setup for hobbots.app that lives outside this repository. The Cloudflare and domain steps come with [#189](https://github.com/otaviobarros/hobbots/issues/189).

## GitHub repository settings

- **Secret scanning** and **push protection** are on, under Settings › Advanced Security. GitHub then blocks a push that contains a known secret, such as a Cloudflare API token. Check with `gh api repos/otaviobarros/hobbots --jq .security_and_analysis`: `secret_scanning` and `secret_scanning_push_protection` read `enabled`.
- The [Site workflow](../../.github/workflows/site.yml) needs no secrets, so it runs the same for pull requests from forks.

## Wait-list database

Each environment has its own D1 database, `hobbots-waitlist-staging` and `hobbots-waitlist-production`, bound as `WAITLIST_DB` in [`wrangler.jsonc`](wrangler.jsonc). Once per environment, from `apps/site` on a machine logged in to Cloudflare:

```sh
wrangler d1 create hobbots-waitlist-staging        # then add its database_id to env.staging in wrangler.jsonc
wrangler d1 migrations apply WAITLIST_DB --env staging --remote
```

Repeat with `production`. The database ID is public and goes in the repository. Apply new files in `migrations/` the same way before deploying code that needs them.

The rate limiter (`SIGNUP_LIMIT`, 5 sign-ups a minute for each IP address) needs no setup: its namespace IDs are in `wrangler.jsonc`.

## Turnstile

One widget in the Cloudflare dashboard under Turnstile, in Managed mode, with the hostnames `hobbots.app` and the staging hostname.

- The **site key** is public. Staging and production builds read it from `TURNSTILE_SITE_KEY` at build time; without it the build uses Cloudflare's test key, which always passes and is refused by the real secret.
- The **secret key** is set once per environment and never written to a file: `wrangler secret put TURNSTILE_SECRET_KEY --env staging`, then `--env production`. Without it, every sign-up is refused.
