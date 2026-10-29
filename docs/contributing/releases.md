# Releases

Hobbots versions itself from its [Conventional Commits](https://www.conventionalcommits.org/). Nobody types a version or a tag by hand: [release-please](https://github.com/googleapis/release-please) reads the commits on `main`, proposes the next version in a pull request, and tags it when that pull request merges.

## Versions

- Hobbots uses [Semantic Versioning](https://semver.org/) with `v` tags: `v0.1.0`, `v0.2.0-beta.1`.
- There is one version for the whole product. It lives in [`apps/desktop/package.json`](../../apps/desktop/package.json), which is the version the app shows in About. Internal packages are not versioned.
- Hobbots stays on `0.x` until its first stable release and keeps version steps small until then. While on `0.x`, `feat`, `fix`, `perf`, `refactor` and `revert` commits all bump the patch version (`0.1.3` → `0.1.4`), and only a breaking change (`feat!:` or a `BREAKING CHANGE:` footer) bumps the minor version (`0.1.4` → `0.2.0`). The first release is `0.0.1` (`initial-version` in the config; without it release-please starts a new project at `1.0.0`). Nothing reaches `1.0.0` on its own; that release is asked for with a `Release-As: 1.0.0` footer, as for a beta below.
- [`.release-please-manifest.json`](../../.release-please-manifest.json) records the last released version and [`release-please-config.json`](../../release-please-config.json) holds the settings. Release-please updates the manifest itself; do not edit it by hand.

## How a release happens

1. Pull requests merge into `main` with a squash commit whose title is a Conventional Commit, so the pull request title is what release-please reads.
2. On every push to `main`, the [Release Please workflow](../../.github/workflows/release-please.yml) opens or updates one release pull request titled `chore(main): release X.Y.Z`. It bumps the version in `apps/desktop/package.json` and adds the `feat`, `fix`, `perf`, `refactor`, `revert` and breaking-change entries to [`CHANGELOG.md`](../../CHANGELOG.md). Other commit types (`docs`, `chore`, `style`, `test`, `build`, `ci`) do not trigger a release on their own; `changelog-sections` in the config decides which types count.
3. A maintainer reviews the release pull request and merges it when the release is ready. Until then it keeps collecting changes.
4. The merge makes release-please create the `vX.Y.Z` tag and a draft GitHub Release with the changelog entry as its notes.
5. The tag starts the release workflow, which builds, smoke-tests and attaches the Apple silicon and Intel `.dmg` files to the release.
6. A maintainer checks the draft release and publishes it.

Release-please runs with a GitHub App token rather than the default `GITHUB_TOKEN`, because GitHub does not start workflows from tags or pull requests that `GITHUB_TOKEN` creates. Without the App, neither CI on the release pull request nor the release build on the tag would run.

## Cutting a beta

A beta is a pre-release version such as `v0.2.0-beta.1`. Ask for it with a `Release-As` footer in a commit on `main`:

1. Open a pull request (an empty `chore` commit is enough) and, when squash-merging it, put the footer on its own line in the commit description:

   ```text
   chore: release 0.2.0-beta.1

   Release-As: 0.2.0-beta.1
   ```

2. Release-please updates the release pull request to `0.2.0-beta.1`. Merge it as usual.
3. When publishing the draft release, tick **Set as a pre-release** so it is not marked as the latest release.

Repeat with `0.2.0-beta.2` and so on for each further beta, and finish with `Release-As: 0.2.0` for the stable release so the version does not jump past it. The same footer cuts `1.0.0` when Hobbots is ready.

## One-time setup

A maintainer sets this up once per repository:

1. Create a GitHub App owned by the maintainer, with no webhook and these repository permissions: Contents read and write, Pull requests read and write, Issues read and write (release-please labels its pull requests). Install it only on this repository.
2. In the repository's **Settings › Secrets and variables › Actions**, add the App's **Client ID** as the variable `RELEASE_APP_CLIENT_ID` and a generated private key as the secret `RELEASE_APP_PRIVATE_KEY`.
