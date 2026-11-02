# packages/charms

Charms of [ADR 014](../../docs/decisions/014-tool-policy-and-enforcement.md#charms): hub tools that reach other apps with credentials the sandbox never holds. Each one provides `CharmTools` from `@hobbots/agents`, which chat turns offer their runtime beside the Task tools.

- `GitHubCharmTools` serves the GitHub Charm's read actions (#317): `github_repository`, `github_search` and `github_item`. Each call is decided by the policy engine as Read GitHub on the hob's folder, with the hob's access read again for the call, and what GitHub returns is redacted before the hob reads it.
- `github_push` pushes a hob's branch (#323). `GitPush` fetches it into a staging repository under the hub's data folder, reading the hob's folder with `git upload-pack` inside the hob's read-only sandbox (`FolderSandbox`), refuses a `.git` with `commondir`, alternates, grafts or shallow history, and pushes from there with the hub's own Git settings: no hook, no configured program, the token on a pipe to its credential helper, or SSH through the user's agent against GitHub's pinned host keys. The push is decided as Push on the hob's folder, with the exact commit on the card.
- `makeCharmCallRunner` runs every Charm write as a recorded call (`CharmCalls`): a key is used once, a lost answer is read back on GitHub with the tool's `ReadBack`, and an uncertain call blocks writes of the same tool on the same site until it settles.
- `GitRemotes` finds a folder's repository from the `origin` remote in its own `.git/config`, read with `git config --file`, which runs nothing.
- `GitHubApi` reads GitHub's REST API with the token `GitHubToken` finds on the hub: `GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token` for github.com.

Tests use stand-ins for GitHub and for remotes, and a real Git for `GitRemotes`.
