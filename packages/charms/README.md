# packages/charms

Charms of [ADR 014](../../docs/decisions/014-tool-policy-and-enforcement.md#charms): hub tools that reach other apps with credentials the sandbox never holds. Each one provides `CharmTools` from `@hobbots/agents`, which chat turns offer their runtime beside the Task tools.

- `GitHubCharmTools` serves the GitHub Charm's read actions (#317): `github_repository`, `github_search` and `github_item`. Each call is decided by the policy engine as Read GitHub on the hob's folder, with the hob's access read again for the call, and what GitHub returns is redacted before the hob reads it.
- `GitRemotes` finds a folder's repository from the `origin` remote in its own `.git/config`, read with `git config --file`, which runs nothing.
- `GitHubApi` reads GitHub's REST API with the token `GitHubCredential` gives for the hob's call. After a 401 it asks once for a refreshed token and tries again; refused again, GitHub is disconnected.
- `GitHubAccountLive` provides `GitHubCredential` and `GitHubConnection` (#322, ADR 020). The user connects one sign-in in Settings: the Hobbots GitHub App with the device flow (`GitHubSignIn`), whose access and refresh tokens are one item in the OS keychain (`Keychain`) and are refreshed one at a time, or a sign-in already on the hub (`LocalGitHubSignIns`: `gh auth token`, or `git credential fill`), read again for each call. The database keeps only which sign-in, the login and when (`GitHubAccounts`). `HOBBOTS_GITHUB_TOKEN` replaces all of them for headless hubs and tests.
- `Keychain` hands the secret to `security -i` (macOS) or `secret-tool` (Linux) on standard input, never on a command line. Without one the hub refuses to connect the app.
- A turn offers the Charm only to a hob that has it granted (`githubCharm` in its policy, on unless turned off) while a sign-in is connected, and each call checks the grant again.

Tests use stand-ins for GitHub and for remotes, and a real Git for `GitRemotes`.
