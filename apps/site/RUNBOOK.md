# Site runbook

One-time setup for hobbots.app that lives outside this repository, and the few tasks that need a Cloudflare login. Every value here is a placeholder in angle brackets, such as `<account-id>`. Real tokens, secrets and account IDs never go in this file. A fork can follow the same steps with its own Cloudflare account, domain and GitHub Environments. The plan is in [#182](https://github.com/otaviobarros/hobbots/issues/182).

## Setting up from scratch

Do these in order. Staging works after step 8, and production after step 9.

1. [Before you start](#before-you-start): a Cloudflare account, its `workers.dev` subdomain and a Wrangler login.
2. [GitHub repository settings](#github-repository-settings): secret scanning and push protection.
3. [Billing alerts and caps](#billing-alerts-and-caps), before anything can cost money.
4. [The hobbots.app zone](#the-hobbotsapp-zone).
5. [Wait-list database](#wait-list-database) for staging.
6. [Turnstile](#turnstile): the widget.
7. [Teaser media bucket](#teaser-media-bucket).
8. [API token and GitHub Environments](#api-token-and-github-environments) for `site-staging`. Push a site change to `main` to deploy staging, then set the staging Turnstile secret key.
9. Production: the wait-list database, the Turnstile secret key, the `site-production` environment, a site release, then the [custom domain](#workers-and-environments).

## Before you start

- One Cloudflare account holds everything: the zone, both Workers, both D1 databases, the R2 bucket and the Turnstile widget.
- Open Workers & Pages once and pick the account's `workers.dev` subdomain. The first deploy runs in CI and cannot answer that prompt.
- Run Wrangler from `apps/site` after `pnpm install`, so it reads [`wrangler.jsonc`](wrangler.jsonc) and uses the pinned version. `pnpm exec wrangler login` opens a browser to log in. `pnpm exec wrangler whoami` shows the account and its ID.
- The commands below write `wrangler` for `pnpm exec wrangler`.
- Run them before building the site, or after deleting `dist` and `.wrangler/deploy`. A build can leave a generated config there that makes Wrangler refuse `--env`.

## GitHub repository settings

- **Secret scanning** and **push protection** are on, under Settings › Advanced Security. GitHub then blocks a push that contains a known secret, such as a Cloudflare API token. Check with `gh api repos/otaviobarros/hobbots --jq .security_and_analysis`: `secret_scanning` and `secret_scanning_push_protection` read `enabled`.
- The [Site workflow](../../.github/workflows/site.yml) needs no secrets, so it runs the same for pull requests from forks.

## The hobbots.app zone

The domain is a zone on the Cloudflare account, with Cloudflare's nameservers at the registrar. Add it under Account home › Add a domain, then set the two nameservers Cloudflare shows at the registrar. The zone is active once Cloudflare sees them.

In the zone:

- **SSL/TLS › Overview:** Full (strict). The Worker and the R2 custom domain get their certificates from Cloudflare, so nothing else is needed.
- **SSL/TLS › Edge Certificates:** Always Use HTTPS on, and Minimum TLS Version 1.2. The zone setting does not apply to R2 custom domains, so the [media bucket](#teaser-media-bucket) sets its own.
- **DNS:** add no records for `hobbots.app` or `media.hobbots.app` by hand. Attaching the custom domains below creates them.

The zone ID is on the zone's Overview page. Only the R2 custom domain command needs it.

## Workers and environments

[`wrangler.jsonc`](wrangler.jsonc) defines two Workers, one for each environment. The [README](README.md#environments) explains how a build picks one.

| Environment          | Worker                                      | Address                                                       | Deployed by                                                      |
| -------------------- | ------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| Staging              | `hobbots-site-staging`                      | `hobbots-site-staging.<account-subdomain>.workers.dev`        | A push to `main` that touches the site                           |
| Pull request preview | A preview version of `hobbots-site-staging` | `pr-<N>-hobbots-site-staging.<account-subdomain>.workers.dev` | A pull request from this repository that touches the site        |
| Production           | `hobbots-site-production`                   | `https://hobbots.app`                                         | A `site-v*` tag from release-please, after a maintainer approves |

The deploys run in [`site-deploy.yml`](../../.github/workflows/site-deploy.yml). Previews share the staging database and do not run migrations. They work only after staging has been deployed once. Only the production deploy builds with `CLOUDFLARE_ENV=production`. Every other build, staging and previews included, marks its pages `noindex, nofollow`, as the [README](README.md#share-card-and-search) explains.

**Custom domain.** Production is reachable only at hobbots.app: its `workers.dev` address and preview URLs are off in `wrangler.jsonc`. After the first production deploy, open Workers & Pages › `hobbots-site-production` › Settings › Domains & Routes › Add › Custom domain, and enter `hobbots.app`. Cloudflare creates the DNS record and the certificate. Add `www.hobbots.app` the same way if you want it. The custom domain is set in the dashboard on purpose, so the deploy token needs no permissions on the zone.

**Invocation logs stay off.** `wrangler.jsonc` keeps Workers Logs on for the Worker's own console logs, and sets `invocation_logs` to `false`. Invocation logs record request metadata for every request, which can include the visitor's IP address, and the wait-list never needs it. Change this in `wrangler.jsonc`, not in the dashboard, so every deploy keeps the same setting.

## Wait-list database

Each environment has its own D1 database, `hobbots-waitlist-staging` and `hobbots-waitlist-production`, bound as `WAITLIST_DB` in [`wrangler.jsonc`](wrangler.jsonc). Create each one before its first deploy, from `apps/site`:

```sh
wrangler d1 create hobbots-waitlist-staging
wrangler d1 migrations apply WAITLIST_DB --env staging --remote
```

Repeat with `production`. If `d1 create` offers to add the database to your config, answer no: it would add it at the top level, which is local development. Wrangler finds each database by its `database_name` under `env.staging` or `env.production`. The database ID is public, so it can also go there as `database_id`, through a pull request. The deploy workflow applies new files in `migrations/` before each staging and production deploy.

The rate limiter (`SIGNUP_LIMIT`, 5 sign-ups a minute for each IP address) needs no setup: its namespace IDs are in `wrangler.jsonc`.

## Turnstile

One widget in the Cloudflare dashboard under Turnstile, in Managed mode, with two hostnames: `hobbots.app` and `<account-subdomain>.workers.dev`. The second one covers staging and every pull request preview.

- The **site key** is public. Staging and production builds read it from `TURNSTILE_SITE_KEY` at build time, which is a variable in each GitHub Environment. Without it, the build uses Cloudflare's test key, which always passes and is refused by the real secret.
- The **secret key** is set once for each environment and never written to a file. The Worker must exist first, so run it after that environment's first deploy: `wrangler secret put TURNSTILE_SECRET_KEY --env staging`, then `--env production`. Until then, every sign-up is refused.

## Teaser media bucket

The teaser video is served from the R2 bucket `hobbots-media` at `https://media.hobbots.app`. The [README](README.md#teaser-video) explains how to upload a new cut. Set the bucket up once:

```sh
wrangler r2 bucket create hobbots-media
wrangler r2 bucket domain add hobbots-media --domain media.hobbots.app --zone-id <zone-id> --min-tls 1.2
wrangler r2 bucket dev-url get hobbots-media   # should report that the r2.dev URL is disabled
```

- The custom domain makes the bucket public at `media.hobbots.app` only, and lets Cloudflare cache the video.
- `--min-tls 1.2` matters because R2 custom domains default to TLS 1.0 and ignore the zone's setting. Check it with `wrangler r2 bucket domain list hobbots-media`, and change it with `wrangler r2 bucket domain update hobbots-media --domain media.hobbots.app --min-tls 1.2`.
- Leave the `r2.dev` URL disabled. If it was turned on, `wrangler r2 bucket dev-url disable hobbots-media` turns it off.
- The bucket holds only public files. The deploy token has no R2 permission, so uploads always come from a maintainer's own login.

## API token and GitHub Environments

Deploys use an account API token with only these permissions, under Manage Account › Account API Tokens › Create Token › Custom token:

| Permission                        | Why                                        |
| --------------------------------- | ------------------------------------------ |
| Account › Workers Scripts › Edit  | Deploy Workers and upload preview versions |
| Account › D1 › Edit               | Apply migrations                           |
| Account › Account Settings › Read | Read the account when Wrangler starts      |
- Make one token for each environment, named `hobbots-site-staging-deploy` and `hobbots-site-production-deploy`, so each can be revoked alone.
- Never reuse the production token for staging. For full isolation between the two, put staging in its own Cloudflare account.
- Set an expiry date, at most a year out, and note it where you track renewals.
- The token needs no zone, R2 or Turnstile permission. If a deploy fails with an authentication error, check the error before adding a permission, and add it to this table in the same pull request.

The tokens live only in two GitHub Environments, under Settings › Environments:

| Environment       | Secrets                                         | Variables            | Protection                                                        |
| ----------------- | ----------------------------------------------- | -------------------- | ----------------------------------------------------------------- |
| `site-staging`    | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | `TURNSTILE_SITE_KEY` | None. The workflow skips pull requests from forks and Dependabot. |
| `site-production` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | `TURNSTILE_SITE_KEY` | Required reviewer: a maintainer. Deployment tags: `site-v*`.      |

The account ID is on Account home, or in `wrangler whoami`. The release-please App needs nothing new.

## Billing alerts and caps

The site should cost nothing or close to it. Cloudflare has no hard spending cap on a paid plan, so the guard is a free plan where possible, plus an alert.

- **Plan.** Stay on Workers Free while it is enough. Its daily limits stop requests instead of billing for them. Moving to Workers Paid removes those limits, and usage past the included amounts is billed.
- **R2** bills storage and operations past its free tier, and egress is free. Keep only the current teaser in the bucket.
- **Budget alert.** Under Billing › Billable Usage, add a budget alert at a small amount, such as 5 USD, sent to the maintainer's email. It warns and does not stop anything.
- **Usage notifications.** Under Notifications › Add, add a Billable Usage notification for each product the site uses that the list offers, such as Workers and R2, at a threshold well above normal traffic.
- If an alert fires, find the product that is billing under Billing › Billable Usage, then act on that product:
  - **Worker requests:** remove the custom domain from `hobbots-site-production`. That stops requests to the site, not to `media.hobbots.app`.
  - **R2 operations:** remove the custom domain from `hobbots-media`. That stops public reads of the media.
  - **R2 storage:** removing a domain changes nothing. Only deleting objects with `wrangler r2 object delete` lowers it.

## Common tasks

### Export the wait-list as CSV

From `apps/site`, with `jq` installed:

```sh
wrangler d1 execute hobbots-waitlist-production --env production --remote --json \
  --command "SELECT email, source, wants_more_platforms, created_at FROM waitlist ORDER BY created_at" \
  | jq -r '["email","source","wants_more_platforms","created_at"], (.[0].results[] | [.email, .source, .wants_more_platforms, .created_at]) | @csv' \
  > waitlist.csv
```

The file holds personal data. Keep it out of the repository and delete it once it is used.

### Remove someone from the wait-list

`d1 execute` cannot bind parameters, so the address goes into the SQL text. Read it with `read -r`, so the shell takes it as typed, and double each `'`, so an address such as `o'brien@example.com` stays one SQL string:

```sh
read -r -p "Email to remove: " EMAIL
SQL_EMAIL=$(printf '%s' "$EMAIL" | sed "s/'/''/g")
wrangler d1 execute hobbots-waitlist-production --env production --remote \
  --command "SELECT email FROM waitlist WHERE email = lower(trim('$SQL_EMAIL'))"
wrangler d1 execute hobbots-waitlist-production --env production --remote \
  --command "DELETE FROM waitlist WHERE email = lower(trim('$SQL_EMAIL'))"
```

The `SELECT` shows the row first. If it returns nothing, check the address before deleting. Emails are stored trimmed and lowercased, so this matches however the person typed it. Remove them from any exported CSV too.

### Rotate a deploy token

1. Create a new token with the same permissions, as in [API token and GitHub Environments](#api-token-and-github-environments).
2. Replace `CLOUDFLARE_API_TOKEN` in that GitHub Environment.
3. Re-run the latest deploy for that environment, and check that it passes.
4. Delete the old token under Account API Tokens.

If a token leaked, delete it first, then do steps 1 to 3.

### Rotate the Turnstile secret key

Under Turnstile › the widget › Settings, rotate the secret key, then run `wrangler secret put TURNSTILE_SECRET_KEY --env staging` and `--env production`. Sign-ups fail between the two steps.

## Values outside the repository

| Value                                                  | Where it lives                                                                     | Secret                             |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------- |
| Cloudflare account and its ID                          | Cloudflare; the ID also in both GitHub Environments as `CLOUDFLARE_ACCOUNT_ID`     | No, but kept out of the repository |
| `workers.dev` account subdomain                        | Cloudflare › Workers & Pages                                                       | No                                 |
| hobbots.app registration and nameservers               | The domain registrar                                                               | No                                 |
| Zone settings: SSL mode, Always Use HTTPS, minimum TLS | Cloudflare › hobbots.app                                                           | No                                 |
| Custom domain `hobbots.app` on the production Worker   | Cloudflare › Workers & Pages                                                       | No                                 |
| Custom domain `media.hobbots.app`, minimum TLS 1.2     | Cloudflare › R2 › `hobbots-media`                                                  | No                                 |
| Teaser video                                           | R2 bucket `hobbots-media`                                                          | No                                 |
| D1 databases and the wait-list rows                    | Cloudflare › D1                                                                    | Rows are personal data             |
| Turnstile widget and hostnames                         | Cloudflare › Turnstile                                                             | No                                 |
| `TURNSTILE_SITE_KEY`                                   | Turnstile; both GitHub Environments as a variable                                  | No                                 |
| `TURNSTILE_SECRET_KEY`                                 | Turnstile; each Worker as a Wrangler secret                                        | Yes                                |
| Deploy tokens                                          | Cloudflare › Account API Tokens; each GitHub Environment as `CLOUDFLARE_API_TOKEN` | Yes                                |
| Environment protection rules                           | GitHub › Settings › Environments                                                   | No                                 |
| Budget alert and usage notifications                   | Cloudflare › Billing and Notifications                                             | No                                 |
| Secret scanning and push protection                    | GitHub › Settings › Advanced Security                                              | No                                 |
