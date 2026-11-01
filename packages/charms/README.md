# packages/charms

Charms of [ADR 014](../../docs/decisions/014-tool-policy-and-enforcement.md#charms): hub tools that reach other apps with credentials the sandbox never holds. Each one provides `CharmTools` from `@hobbots/agents`, which chat turns offer their runtime beside the Task tools.

- `GitHubCharmTools` serves the GitHub Charm's read actions (#317): `github_repository`, `github_search` and `github_item`. Each call is decided by the policy engine as Read GitHub on the hob's folder, with the hob's access read again for the call, and what GitHub returns is redacted before the hob reads it.
- `GitRemotes` finds a folder's repository from the `origin` remote in its own `.git/config`, read with `git config --file`, which runs nothing.
- `GitHubApi` reads GitHub's REST API with the token `GitHubToken` finds on the hub: `GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token` for github.com.

Tests use stand-ins for GitHub and for remotes, and a real Git for `GitRemotes`.
