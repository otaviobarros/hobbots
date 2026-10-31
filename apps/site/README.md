# apps/site

The website at hobbots.app: an [Astro](https://astro.build/) site that runs on Cloudflare Workers through the [`@astrojs/cloudflare`](https://docs.astro.build/en/guides/integrations-guide/cloudflare/) adapter. Pages are prerendered. The plan and its steps are in [#182](https://github.com/otaviobarros/hobbots/issues/182).

## Run it

From the repository root, after `pnpm install`:

```sh
cp apps/site/.dev.vars.example apps/site/.dev.vars   # Turnstile test secret, git-ignored
pnpm --filter @hobbots/site exec wrangler d1 migrations apply WAITLIST_DB --local   # create the local wait-list table
pnpm --filter @hobbots/site dev       # dev server on http://localhost:4321
pnpm --filter @hobbots/site build     # static pages and the Worker in apps/site/dist
pnpm --filter @hobbots/site preview   # serves the build in the local Workers runtime
pnpm --filter @hobbots/site typecheck # astro check
pnpm --filter @hobbots/site test:e2e  # Playwright against the build, served by astro preview
```

The adapter reads [`wrangler.jsonc`](wrangler.jsonc), so the dev server and preview get a local D1 database (`WAITLIST_DB`) and rate limiter (`SIGNUP_LIMIT`) with no Cloudflare account. Local state lives in `apps/site/.wrangler/`, which is git-ignored.

## The wait-list

Both forms call the Astro Action `waitlist.join` in `src/actions/index.ts`. The rules are in `src/waitlist/join.ts`: the email is trimmed, lowercased and stored once in the `waitlist` table (`migrations/`), a filled honeypot field is answered as a success and stored nowhere, each IP address gets 5 tries a minute, and the Turnstile token is checked on the server with `TURNSTILE_SECRET_KEY`. A repeated email gets the same answer as a new one, so the form never reveals who is on the list. The action never logs the email or the IP address, and `wrangler.jsonc` turns off Cloudflare's invocation logs, which record request metadata.

Locally, the Turnstile widget uses Cloudflare's test site key and the server uses the test secret from `.dev.vars`, so every check passes. Both still call Cloudflare, so the form needs a network connection.

## The page

`src/pages/index.astro` is the coming soon page from board 1 of the [design canvas](https://claude.ai/artifact/3WYsG82CcZps5toC8sEu6L), built from one component per section in `src/components`. The hobs, the chief and the moon come from [`@hobbots/art`](../../packages/art/README.md), the same drawings the app uses. The page's words and lists are in `src/data/copy.ts`, and the village layout and pixel icons in `src/data/scene.ts`.

Only the interactive parts run script, all from `src/scripts/page.ts`: clicking the hobs, the sound switch, rolling a hob, the approval demo, the hob that follows you down the page and the wait-list forms. Every animation is stepped and stops with Reduce motion.

## Checks

`pnpm check` lints, typechecks and unit-tests the site with the rest of the workspace. The [Site workflow](../../.github/workflows/site.yml) builds it and runs the end-to-end tests in `e2e/`, only when `apps/site`, `packages/art`, `pnpm-lock.yaml` or the workflow changes. Build before running `test:e2e` locally, after copying `.dev.vars`: the build copies it into `dist/server`, where `astro preview` reads it. Astro moves `astro preview` to the background when it detects a coding agent (`CLAUDECODE` or `AI_AGENT` set), which Playwright reads as a failed start; unset those variables for the run.

## Share card and search

`src/components/Meta.astro` writes the page's title, description, canonical URL (always `https://hobbots.app/`), Open Graph and X card tags, and icon links; the words are `SHARE` in `src/data/copy.ts`. The card image, `public/og.png`, is the teaser poster cropped to 1280 × 672 and scaled to 1200 × 630: `magick public/teaser/poster.webp -crop 1280x672+0+0 +repage -filter Lanczos -resize 1200x630! -strip public/og.png`. Card checkers such as opengraph.xyz and X read `https://hobbots.app`, so check the card once production is live. `public/robots.txt` and `public/sitemap.xml` point crawlers at the one page.

Only a build with `CLOUDFLARE_ENV=production` may be indexed. Every other build (local, staging, pull request previews) adds `<meta name="robots" content="noindex, nofollow">`, so never build a preview with `CLOUDFLARE_ENV=production`. A production build served from its `workers.dev` or version preview URL is not noindex; its canonical URL still points at hobbots.app.

The favicons in `public/` (`favicon.svg`, `favicon.ico` and the 180 px `apple-touch-icon.png`) are drawn from the app icon's grid in `apps/desktop/scripts/app-icon.ts`. Run `pnpm --filter @hobbots/site icons` after changing the art.

## Teaser video

The teaser is not in this repository. It is served from the public R2 bucket `hobbots-media` at `https://media.hobbots.app` (`TEASER_URL` in `src/data/copy.ts`); only its poster, `public/teaser/poster.webp`, is here. To publish a new cut, compress it to an H.264 MP4 with `-movflags +faststart` and upload it from a machine logged in to Cloudflare:

```sh
wrangler r2 bucket create hobbots-media   # once
wrangler r2 object put hobbots-media/teaser/night-shift-60s.mp4 --file night-shift-60s.mp4 --content-type video/mp4 --remote
```

The bucket's custom domain, `media.hobbots.app`, is set once on Cloudflare under R2 › hobbots-media › Settings › Custom domains.

## Environments

`wrangler.jsonc` has a top level for local development and two environments, `staging` and `production`. Bindings are not inherited, so each environment declares its own. Build for one with `CLOUDFLARE_ENV=staging pnpm --filter @hobbots/site build`. The environment is fixed at build time, so `wrangler deploy` afterwards takes no `--env`.

The [Site deploy workflow](../../.github/workflows/site-deploy.yml) runs the D1 migrations and deploys: a push to `main` deploys `staging`, and a `site-v*` tag from release-please deploys `production` after a maintainer approves. A pull request from this repository uploads a preview version of the staging Worker and comments its URL; previews share the staging database and run no migrations. A `feat` or `fix` commit that touches `apps/site` opens the site release pull request, which tags `site-v*`. Commits that change only `apps/site` are excluded from desktop releases.

## Secrets

The settings and values kept outside the repository are listed in the [runbook](RUNBOOK.md).

This repository is public. Only public values go in it: binding names, D1 database IDs, the Turnstile site key and Cloudflare's [Turnstile test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/). The Turnstile secret key is set on Cloudflare with `wrangler secret put`, and `.dev.vars` never leaves your machine.

## TypeScript

`astro check` does not support TypeScript 7 yet, so this package pins TypeScript 6 for its typecheck. The rest of the workspace stays on TypeScript 7.
