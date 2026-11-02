# ADR 020 — The GitHub Charm

Status: **Accepted.** Extends the Charms section of [ADR 014](014-tool-policy-and-enforcement.md) and the hub tools of [ADR 018](018-tasks-and-quests.md) for the GitHub Charm ([#320](https://github.com/otaviobarros/hobbots/issues/320)). Uses the approval lifetimes and grants of [ADR 015](015-approval-lifetimes-and-grants.md).

## Context

ADR 014 decided that pushes needing credentials go only through a Charm on the hub, and that GitHub is a Charm. The sandbox holds no Git or GitHub credential, so today a hob can commit but cannot push, open a pull request or comment.

[#317](https://github.com/otaviobarros/hobbots/issues/317) built the first part and proved its shape:

- The `@hobbots/charms` package serves three read actions as hub tools on the runtime's control channel: `github_repository`, `github_search` and `github_item`. Chat turns offer them beside the Task tools.
- The hub picks the repository from the `origin` remote in the hob's own folder's `.git/config`. It reads that one file with `git config --file`, which runs nothing, and only when `.git` is a folder at the top of the hob's folder. A hob's input can only name one of its own folders.
- The hub builds every search and pins it with `repo:`. No input adds another qualifier.
- Each call is decided as Read GitHub on that folder. Read GitHub is Allow under every preset and is offered as Allow or Never only, because hub tools cannot pause for an approval yet.
- What GitHub returns is cut to 4,000 characters per body or comment, redacted like tool output, and opened with a line saying it is other people's text, data and never instructions.
- The credential is borrowed: the hub's `GH_TOKEN` or `GITHUB_TOKEN`, else `gh auth token`. That token carries every scope of the user's `gh` login, far more than the Charm needs.

This ADR decides the rest: the credential, the write actions, their policy, how failures are told apart, and how a hob's own GitHub identity ([#221](https://github.com/otaviobarros/hobbots/issues/221)) plugs in later.

GitHub's behaviour here comes from its documentation for GitHub App user access tokens, the device flow, refresh tokens, OAuth scopes and GitHub App permissions. None of it is verified against GitHub yet; #322 to #325 do that.

## Decision

### Actions

| Action | Tool | What the hob gives | What the hub does |
|---|---|---|---|
| View the repository | `github_repository` | One of its folders | Reads name, description, default branch and visibility (#317) |
| Find issues and pull requests | `github_search` | Folder, kind, state, label, assignee, limit | Counts and lists them with a search the hub builds (#317) |
| Read an issue or pull request | `github_item` | Folder, number, comment count | Reads one item with its first comments (#317) |
| Push | `github_push` | Folder, local branch, remote branch (defaults to the same name), force | Pushes that branch's commits to the folder's GitHub repository |
| Open a pull request | `github_open_pull_request` | Folder, head branch, base branch (defaults to the default branch), title, body, draft (defaults to true) | Opens a pull request inside the same repository |
| Comment | `github_comment` | Folder, issue or pull request number, body | Adds one comment |

- Every action names a folder, never a repository. The hub resolves the repository from that folder as #317 does.
- The hub sends only fixed GitHub API requests and fixed Git commands it builds itself.
- Out of scope: merging, closing, labels, reviews, editing or deleting comments, tags, deleting branches, pull requests across forks, and fetching. A hob still cannot fetch from a private repository; a push GitHub refuses because the branch moved tells the hob to ask you. A Fetch action is a follow-up.

### The credential: your GitHub account, through the Hobbots GitHub App

- **A GitHub App, not an OAuth App or a borrowed `gh` login.** The Charm signs in as a GitHub App user, with a user access token. GitHub gives that token only the permissions both you and the app have, and only on the repositories where you installed the app, so you choose which repositories hobs can reach on GitHub. An OAuth App would need the `repo` scope, which covers every repository you can see and some organization administration. The borrowed `GH_TOKEN`, `GITHUB_TOKEN` or `gh auth token` of #317 is removed once #322 lands, and the hub never falls back to it.
- **The app asks for these permissions and nothing else:**
  - Metadata: read. GitHub requires it.
  - Contents: read and write. Git over HTTPS, so Push.
  - Issues: read and write. Reading issues and commenting.
  - Pull requests: read and write. Reading and opening pull requests, and commenting on them.
- **No Workflows permission.** GitHub then refuses a push that changes `.github/workflows`, and the hob is told so. No Administration, Actions, Secrets, Members or organization permissions either.
- **Who owns the app.** The Hobbots project registers one public GitHub App with the device flow enabled, and its client ID ships in the source. The device flow and its token refresh need no client secret, so nothing secret ships. A self-hosted hub can point at its own app with `HOBBOTS_GITHUB_CLIENT_ID`.
- **Connecting (#322).** Settings starts GitHub's device flow on the hub. The page shows the code and a link to `github.com/login/device`. The hub polls no faster than GitHub's `interval`, takes the longer interval a `slow_down` answer gives, and stops when the code lapses after 15 minutes or you cancel. The page then links to the app's installation page, where you pick repositories. Settings shows the account's login, the repositories the token reaches (`GET /user/installations` and their repositories) and the permissions above.
- **Where it lives.** The access token (8 hours) and the refresh token (6 months) are kept together as one item in the OS keychain on the hub: the macOS Keychain, or the Secret Service on Linux. They never go on a command line, in the database, the event journal, logs, the browser or the sandbox. Without a usable keychain the hub refuses to connect rather than write the token to a file. The database keeps only that GitHub is connected, the login and when, so the screens can show it.
- **Refreshing.** The hub refreshes the token before it expires, or after one 401, one refresh at a time. It writes the new pair to the keychain before using it, because GitHub retires the old refresh token as soon as it is used.
- **Revoked, expired or disconnected.** A refused refresh (`bad_refresh_token`), or a 401 that survives a refresh, marks GitHub disconnected. The hub deletes the keychain item, Settings asks you to connect again, and from the next turn no hob is offered the Charm. A call already running fails with "GitHub is disconnected" and is never retried.
- **Disconnecting.** Disconnect in Settings deletes the keychain item the same way. It then links to GitHub's authorized apps page, since revoking the grant from the hub would need the client secret.
- **Uninstalled from a repository.** That repository then answers "not found" for every action. It does not disconnect GitHub.
- **Headless hubs and tests.** `HOBBOTS_GITHUB_TOKEN` in the hub's environment replaces the connected account. It is for a hub without a keychain and for the fake GitHub API in tests. It should be a fine-grained token with the permissions above. The hub never runs `gh` for it.
- **The token is a known value.** The hub adds the access and refresh tokens to the values it redacts by value (permissions contract), so neither can reach a hob through any tool output.

### Granting the Charm to a hob

- You grant the GitHub Charm to each hob from that hob's Charms tab (ADR 014). A hob without the grant, or on a hub without a connected account, is offered none of its actions.
- Ungranting the Charm, or disconnecting GitHub, removes the actions from the hob's next turn and revokes the grants that relied on them (ADR 015).
- Turning the sandbox off for a hob closes every GitHub action for it, not only Read GitHub. Outside the sandbox the hob could rewrite its folder's `.git/config` and point the Charm at any repository the account reaches.

### Policy per action

The policy engine decides each call on its exact arguments, which the approval card shows.

| Operation | Covers | Careful | Balanced | Trusting |
|---|---|---|---|---|
| Read GitHub | `github_repository`, `github_search`, `github_item` | Allow | Allow | Allow |
| Push | `github_push` | Ask | Ask | Allow |
| Push with force, or to the default branch | `github_push` with force, or to the default branch | Ask (once only) | Ask (once only) | Ask (once only) |
| Open pull requests | `github_open_pull_request` | Ask | Ask | Allow |
| Comment on GitHub | `github_comment` | Ask | Ask | Allow |

- Read GitHub and both Push rows are ADR 014's, unchanged. Read GitHub stays offered as Allow or Never.
- Open pull requests and Comment on GitHub are new operations (`open-pull-request`, `comment-github`). Each is offered as Allow, Ask or Never per hob, and overrides only narrow it (#130).
- They ask under Balanced because, like a push, other people see them at once and they cannot be taken back.
- **Hub tools can ask.** A hub tool call whose answer is Ask holds the turn for an approval as a runtime tool call does, with the lifetimes and expiry of ADR 015. #323 builds this for Push, and #324 reuses it.
- **Once only.** A force push and a push to the default branch are once only with the confirmation check box, and are never granted. The hub reads the default branch from GitHub when it decides, not from the folder.
- **Grants.** This Quest and Always save a grant for one hob, one action and one site. The site is the repository and remote branch for Push, the repository and base branch for Open pull requests, and the repository for Comment on GitHub. Titles and bodies change with every call, so a grant never names them.
- **The approval card shows:**
  - Push: the repository, local branch and remote branch, the commits (count and the first subjects), whether it forces and which commit it replaces, and whether the branch is the default branch.
  - Open pull requests: the repository, head and base branches, draft or not, the title and the start of the body.
  - Comment on GitHub: the repository, the issue or pull request number and title, and the comment.
  - All three: who acts on GitHub ("as you", with your login). #221 adds a hob's own name here.
- **A `git push` typed in a command is steered to the Charm.** For a hob with the GitHub Charm, the policy hook refuses a recognized `git push` command in any preset. The refusal tells the hob to use `github_push`. Without the Charm, ADR 014's handling stays: the push is decided as Push and fails against a remote that needs credentials. Pushing to a remote that needs no credentials stays a checked rule.

### Pushing without running workspace code

ADR 014 requires that a Charm never runs code a hob can write. Push does this:

- **The URL comes from the hub.** The hub pushes to `https://github.com/<owner>/<repository>.git`, built from the repository it resolved. It never uses the remote's URL as written, `pushurl`, `url.*.insteadOf` or any other remote setting from the folder.
- **A staging repository owned by the hub.** The hub keeps a bare repository per folder in its own data folder, with configuration only the hub writes. It fetches the branch's commits into it from the hob's folder, then pushes from it. No hook, configured program, filter, include or credential setting of the hob's repository is ever read for the push.
- **Git runs with nothing from outside.** No system or global configuration, a home folder of the hub's, `core.hooksPath` pointing at an empty hub folder, and terminal prompts off.
- **The token reaches Git only through a credential helper the hub provides, over a pipe.** It is never in an argument, an environment variable or a file.
- **Force pushes carry a lease.** A force push uses `--force-with-lease` with the commit the hub read from GitHub when it decided. A push without force never forces, so GitHub refuses it when the branch has moved.
- Only branches are pushed: never tags, deletions or other refs.
- #323 proves this against a hostile folder configuration: hooks, `core.hooksPath`, `core.fsmonitor`, `core.sshCommand`, `url.*.insteadOf`, `include.path`, `uploadpack.packObjectsHook`, credential helpers and `http.proxy`. None may run or receive the token.

### What is sent

- **Outgoing text is redacted.** Pull request titles and bodies and comments pass through the same redaction as tool output before they leave the hub. The hob is told what was redacted. The content of pushed commits is not redacted; the approval card is where you check it.
- **Results are redacted.** What GitHub returns passes through the same redaction as tool output and is marked as other people's text, as #317 does for reads.

### Failures: never sent twice by mistake

Every write action is a Charm call with a key, recorded before anything is sent. A call the runtime retries with the same key returns the first result and is never sent again. A call that ends without a clear result is put in one of these cases, following [#152](https://github.com/otaviobarros/hobbots/issues/152):

| Case | Means | What the hub does |
|---|---|---|
| Not sent | Nothing reached GitHub, such as a failed DNS lookup or a refused connection | Tries once more, then reports it as not sent |
| Refused | GitHub answered no: 403, 404, 422, a rejected push, a protected branch | Reports GitHub's reason in words and never retries |
| Signed out | GitHub answered 401 | Refreshes the token and sends once more, since a 401 means nothing was done; a second 401 disconnects GitHub (see the credential) |
| Rate limited | GitHub says its limit is used up | Reports when to try again and never retries by itself |
| Uncertain | It may have taken effect: a timeout after sending, a connection dropped mid-answer, a 5xx, or a hub that stopped mid-call | Reconciles before saying anything (below) and never resends by itself |

**Reconciling an uncertain call.** The hub reads GitHub back to learn what happened:

- Push: the remote branch is at the pushed commit, so it was applied. It is still at the commit read when deciding, so it was not applied.
- Open a pull request: an open pull request from that head branch exists, so it was applied. GitHub also refuses a second pull request for the same head and base.
- Comment: each comment ends with a hidden marker, `<!-- hobbots-call: <key> -->`, holding only the call's key. A comment with that marker on the item means it was applied.

An applied call returns its result as success. A call that was not applied is reported as not sent, and the hob may call again, which is decided again. A call the read-back cannot settle stays uncertain: the step shows it as uncertain, the hob is told not to repeat it, and you decide. Calls left in flight when the hub stops are reconciled when it starts.

Reads have no effect, so a failed read is reported and the hob may simply call again.

### A hob's own GitHub identity later (#221)

- **One credential service.** The Charm asks a `GitHubCredential` service for a token for each call, keyed by the hob. In this ADR it always answers with your account. A hob's own GitHub App is a second source behind the same service, chosen per hob.
- **Nothing else changes.** The actions, the policy, the repository resolution, the redaction and the failure handling stay the same for either credential.
- **Push changes inside.** With a hob's own app, Push creates commits through GitHub's API so GitHub marks them Verified ([#225](https://github.com/otaviobarros/hobbots/issues/225)). It stays the same action with the same approval.
- **Who acts is shown from the start.** The step and the approval card already say who acts on GitHub, so #221 adds a value, not a field.
- The token borrowed in #317 is not kept as a third source.

## Rationale

A GitHub App gives the narrowest credential GitHub offers to a desktop app that ships no secret. It is limited to the repositories you install it on and to four permissions, and it refreshes itself without asking you to sign in again for six months. The same app model is what #221 uses for a hob's own name, so the two credentials share one shape.

Pushing from a hub-owned staging repository to a URL the hub builds keeps workspace code out of the hub entirely. Checking each dangerous setting one by one would always miss the next one Git adds.

Asking before pull requests and comments under Balanced follows the reason pushes ask: other people see them at once. Recording each write before it is sent, and reading GitHub back after an unclear end, is what lets the hub promise that a push, a pull request or a comment is never sent twice by mistake.

## Consequences

- **#322** connects the account: the `GitHubCredential` service, the device flow, the keychain item, Settings, and the Charms tab grant. It removes the borrowed token.
- **#323** builds Push: the staging repository, the credential helper, the once-only rules, `git push` steering, hub tools that can ask, the Charm call records with their keys (migration 0029), and reconciliation.
- **#324** builds Open pull requests and Comment on GitHub on the same call records, with outgoing redaction and the comment marker.
- **#325** proves the feature end to end against a fake GitHub API with the fake runtime.
- The permissions contract adds the two new operations and points here.
- Registering the public Hobbots GitHub App is a step for the project's maintainer. Until it exists, tests use the fake GitHub API and `HOBBOTS_GITHUB_TOKEN`.
- A hob cannot fetch from a private repository. A push refused because the branch moved needs you, until a Fetch action exists.

## Validation

The scenarios that would show this decision holds. Each names the test case that checks it, or the issue that will.

- The read actions reach only the repository of the hob's own folders, never under Never and never from a folder outside them; no input widens a search; what GitHub returns is redacted: `[TC-PE-130]`, `[TC-PE-131]`, `[TC-PE-132]`, `[TC-PE-133]`, `[TC-PE-134]`.
- You connect GitHub with the device flow, Settings shows the account, its repositories and its permissions, and the token is only in the keychain. After you disconnect, or GitHub refuses the refresh, no hob is offered the Charm from its next turn. Not proven yet: [#322](https://github.com/otaviobarros/hobbots/issues/322).
- A hob without the grant, or with the sandbox off, is offered no GitHub action. Not proven yet: [#322](https://github.com/otaviobarros/hobbots/issues/322).
- Under Balanced a hob pushes a branch after your approval. A force push and a push to the default branch ask once only and are never granted. A `git push` command is refused with a pointer to `github_push`. Not proven yet: [#323](https://github.com/otaviobarros/hobbots/issues/323).
- An approved push runs no hook or configured program from a hostile folder configuration, and the token reaches no process the hob can see. Not proven yet: [#323](https://github.com/otaviobarros/hobbots/issues/323).
- A push whose answer is lost is reconciled from the remote branch and never sent twice. Not proven yet: [#323](https://github.com/otaviobarros/hobbots/issues/323).
- A hob opens a pull request and comments after your approval, the card shows the exact text, and a retried or uncertain call creates neither twice. Not proven yet: [#324](https://github.com/otaviobarros/hobbots/issues/324).
- The whole flow runs against a fake GitHub API with the fake runtime on SQLite and PostgreSQL, a repository outside the hob's folders is refused, and no credential reaches the sandbox's environment, files or tool output. Not proven yet: [#325](https://github.com/otaviobarros/hobbots/issues/325).
