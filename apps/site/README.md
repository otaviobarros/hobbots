# apps/site

The website at hobbots.app: an [Astro](https://astro.build/) site that runs on Cloudflare Workers through the [`@astrojs/cloudflare`](https://docs.astro.build/en/guides/integrations-guide/cloudflare/) adapter. Pages are prerendered. The plan and its steps are in [#182](https://github.com/otaviobarros/hobbots/issues/182).

## Run it

From the repository root, after `pnpm install`:

```sh
cp apps/site/.dev.vars.example apps/site/.dev.vars   # Turnstile test keys, git-ignored
pnpm --filter @hobbots/site dev       # dev server on http://localhost:4321
pnpm --filter @hobbots/site build     # static pages and the Worker in apps/site/dist
pnpm --filter @hobbots/site preview   # serves the build in the local Workers runtime
pnpm --filter @hobbots/site typecheck # astro check
```

The adapter reads [`wrangler.jsonc`](wrangler.jsonc), so the dev server and preview get a local D1 database (`WAITLIST_DB`) and rate limiter (`SIGNUP_LIMIT`) with no Cloudflare account. Local state lives in `apps/site/.wrangler/`, which is git-ignored.

## Environments

`wrangler.jsonc` has a top level for local development and two environments, `staging` and `production`. Bindings are not inherited, so each environment declares its own. Build for one with `CLOUDFLARE_ENV=staging pnpm --filter @hobbots/site build`.

## Secrets

This repository is public. Only public values go in it: binding names, D1 database IDs, the Turnstile site key and Cloudflare's [Turnstile test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/). The Turnstile secret key is set on Cloudflare with `wrangler secret put`, and `.dev.vars` never leaves your machine.

## TypeScript

`astro check` does not support TypeScript 7 yet, so this package pins TypeScript 6 for its typecheck. The rest of the workspace stays on TypeScript 7.
