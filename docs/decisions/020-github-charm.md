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
| Push | `github_push` | Folder, local branch, remote branch (defaults to the same name), force | Pushes the commit that branch points to when the call is decided |
| Open a pull request | `github_open_pull_request` | Folder, head branch, base branch (defaults to the default branch), title, body, draft (defaults to true) | Opens a pull request inside the same repository |
| Comment | `github_comment` | Folder, issue or pull request number, body | Adds one comment |

- Every action names a folder, never a repository. The hub resolves the repository from that folder as #317 does.
- The hub sends only fixed GitHub API requests and fixed Git commands it builds itself.
- **Branch names are checked.** A branch name must pass `git check-ref-format --branch`, and may not start with `-`, or be `HEAD` or start with `refs/`. Git commands take full refspecs after `--end-of-options`, so no name becomes an option.
- Out of scope: merging, closing, labels, reviews, editing or deleting comments, tags, deleting branches, pull requests across forks, and fetching. A hob still cannot fetch from a private repository; a push GitHub refuses because the branch moved tells the hob to ask you. A Fetch action is a follow-up.

### The credential: your GitHub account

- **A GitHub App, not an OAuth App or a borrowed `gh` login.** The Charm signs in as a GitHub App user, with a user access token. GitHub gives that token only the permissions both you and the app have, and its writes and private reads only on the repositories where you installed the app. GitHub also lets such a token read any public repository, so the hub adds its own check (below): with the app, every action is refused for a repository the app is not installed on. You choose which repositories hobs can reach on GitHub. An OAuth App would need the `repo` scope, which covers every repository you can see and some organization administration. It is the recommended choice. The silent fallback of #317 to `GH_TOKEN`, `GITHUB_TOKEN` or `gh auth token` goes away once #322 lands: the hub uses only the credential you chose.
- **The app asks for these permissions and nothing else:**
  - Metadata: read. GitHub requires it.
  - Contents: read and write. Git over HTTPS, so Push.
  - Issues: read and write. Reading issues and commenting.
  - Pull requests: read and write. Reading and opening pull requests, and commenting on them.
- **No Workflows permission.** GitHub then refuses a push that adds or changes a workflow file in `.github/workflows`, and the hob is told so. No Administration, Actions, Secrets, Members or organization permissions either.
- **Who owns the app.** The Hobbots project registers one public GitHub App with the device flow enabled, and its client ID ships in the source. Its registration keeps user access tokens expiring, so every token lasts 8 hours and comes with a refresh token. The device flow and its token refresh need no client secret, so nothing secret ships. A self-hosted hub can point at its own app with `HOBBOTS_GITHUB_CLIENT_ID`.
- **Connecting (#322).** Settings starts GitHub's device flow on the hub. The page shows the code and a link to `github.com/login/device`. The hub polls no faster than GitHub's `interval`, takes the longer interval a `slow_down` answer gives, and stops when the code lapses after 15 minutes or you cancel. The page then links to the app's installation page, where you pick repositories. Settings shows the account's login, the repositories the token reaches (`GET /user/installations` and their repositories) and the permissions above.
- **Where it lives.** The access token (8 hours) and the refresh token (6 months) are kept together as one item in the OS keychain on the hub: the macOS Keychain, or the Secret Service on Linux. They never go on a command line, in the database, the event journal, logs, the browser or the sandbox. Without a usable keychain the hub refuses to connect rather than write the token to a file. The database keeps only that GitHub is connected, the login and when, so the screens can show it.
- **Refreshing.** The hub refreshes the token before it expires, or after one 401, one refresh at a time. It writes the new pair to the keychain before using it, because GitHub retires the old refresh token as soon as it is used.
- **Revoked, expired or disconnected.** A refused refresh (`bad_refresh_token`), or a 401 that survives a refresh, marks GitHub disconnected. The hub deletes the keychain item, Settings asks you to connect again, and from the next turn no hob is offered the Charm. A call already running fails with "GitHub is disconnected" and is never retried.
- **Disconnecting.** Disconnect in Settings deletes the keychain item the same way. It then links to GitHub's authorized apps page, since revoking the grant from the hub would need the client secret.
- **Installed repositories only.** With the app, the hub checks before every action that the resolved repository is one of the app's installed repositories for your account (`GET /user/installations` and each installation's repositories), cached for at most a minute. A repository outside them is refused with "The Hobbots app is not installed on this repository" and a link to change that, public repositories included. Uninstalling the app from a repository therefore closes it to hobs within a minute. It does not disconnect GitHub. The `gh` sign-in and Git's credential have no installations, so this check does not apply to them, which is why they are labeled as reaching every repository.
- **Or a sign-in already on this computer.** Settings › GitHub lists what the hub finds on the hub, each as one click, the way onboarding lists the providers it finds. It never asks you to paste a token.
  - **Your GitHub CLI sign-in:** when `gh` is signed in to github.com, the hub offers it with its login and reads it with `gh auth token` for each call, as #317 does today.
  - **Git's own credential for github.com:** when Git's credential helper (the macOS keychain helper or Git Credential Manager) holds one, the hub offers it and reads it with `git credential fill` for each call, with a hub-only configuration so no repository setting chooses the helper.
  - Both are labeled as reaching every repository the sign-in can see, unlike the app. The hub stores neither: it reads them again for each call, so signing out of `gh` or Git ends them.
  - Whichever credential you choose, the hub still picks the repository from the hob's folder, so a wider sign-in never lets a hob reach another repository through the Charm.
- **Pushing with your SSH agent.** As an option, Push can go over SSH with your SSH agent, such as 1Password's, instead of the token. The hub pushes to `git@github.com:<owner>/<repository>.git`, built from the repository it resolved, with your `~/.ssh` configuration (a hob cannot write it), host keys checked against GitHub's, and no setting from the hob's repository. The agent asks for its own approval, such as 1Password's Touch ID, on top of the hob's policy. SSH only pushes: reading, opening pull requests and commenting still need one of the credentials above. The hub never gives the agent to the sandbox for this; the signing switch of ADR 014 stays separate.
- **Headless hubs and tests.** `HOBBOTS_GITHUB_TOKEN` in the hub's environment replaces the connected account. It is for a hub without a keychain and for the fake GitHub API in tests. It should be a fine-grained token with the permissions above. The hub never runs `gh` for it.
- **The token is a known value.** The hub adds every token it uses to the values it redacts by value (permissions contract), so none can reach a hob through any tool output.

### Granting the Charm to a hob

- You grant the GitHub Charm to each hob from that hob's Charms tab (ADR 014). A hob without the grant, or on a hub without a connected account, is offered none of its actions.
- Today the reads of #317 are offered on every chat turn with no grant. #322 adds the grant. Hobs that exist then keep the Charm granted, so their reads keep working, and a new hob gets it granted. You turn it off per hob; the policy still decides each action.
- Ungranting the Charm, or disconnecting GitHub, removes the actions from the hob's next turn and revokes the grants that relied on them (ADR 015).
- Turning the sandbox off for a hob closes every GitHub action for it, not only Read GitHub. Outside the sandbox the hob could rewrite its folder's `.git/config` and point the Charm at any repository the account reaches.

### Policy per action

The policy engine decides each call on its exact arguments, which the approval card shows. What is approved is exactly what is sent: the hub fixes the commit for Push and redacts outgoing text before it decides, and the approval's digest covers them.

| Operation | Covers | Careful | Balanced | Trusting |
|---|---|---|---|---|
| Read GitHub | `github_repository`, `github_search`, `github_item` | Allow | Allow | Allow |
| Push | `github_push` | Ask | Ask | Allow |
| Push with force, or to the default branch | `github_push` with force, or to the default branch | Ask (high risk) | Ask (high risk) | Ask (high risk) |
| Open pull requests | `github_open_pull_request` | Ask | Ask | Allow |
| Comment on GitHub | `github_comment` | Ask | Ask | Allow |

- Read GitHub and both Push rows are ADR 014's, unchanged. Read GitHub stays offered as Allow or Never by choice, even once hub tools can ask: it only investigates the hob's own project, so asking would interrupt without protecting anything.
- Open pull requests and Comment on GitHub are new operations (`open-pull-request`, `comment-github`). Each is offered as Allow, Ask or Never per hob, and overrides only narrow it (#130).
- They ask under Balanced because, like a push, other people see them at once.
- **Not high risk.** The GitHub Charm marks none of its new actions high risk in the sense of ADR 015. A pull request or comment reaches only the hob's own repository, and you can close, edit or delete it, unlike a message sent to other people. So This Quest and Always are offered for them.
- **Hub tools can ask.** A hub tool call whose answer is Ask holds the turn for an approval as a runtime tool call does, with the lifetimes and expiry of ADR 015. #323 builds this for Push, and #324 reuses it.
- **High risk.** A push with force, or to the default branch, is high risk (ADR 015): once only, with the confirmation check box, and never granted. The hub reads the default branch from GitHub when it decides, not from the folder.
- **Grants.** This Quest and Always save a grant for one hob, one action and one site. The site is the repository and remote branch for Push, the repository and base branch for Open pull requests, and the repository for Comment on GitHub. Titles and bodies change with every call, so a grant never names them.
- **The approval card shows:**
  - Push: the repository, local branch and remote branch, the commit it pushes, the commits (count and the first subjects), whether it forces and which commit it replaces, and whether the branch is the default branch.
  - Open pull requests: the repository, head and base branches, draft or not, the title and the start of the body.
  - Comment on GitHub: the repository, the issue or pull request number and title, and the comment.
  - All three: who acts on GitHub ("as you", with your login). #221 adds a hob's own name here.
- **A `git push` typed in a command is steered to the Charm.** For a hob with the GitHub Charm, the policy hook refuses a recognized `git push` command in any preset. The refusal tells the hob to use `github_push`. Without the Charm, ADR 014's handling stays: the push is decided as Push and fails against a remote that needs credentials. Pushing to a remote that needs no credentials stays a checked rule.

### Pushing without running workspace code

ADR 014 requires that a Charm never runs code a hob can write. Push does this:

- **The URL comes from the hub.** The hub pushes to `https://github.com/<owner>/<repository>.git`, built from the repository it resolved. It never uses the remote's URL as written, `pushurl`, `url.*.insteadOf` or any other remote setting from the folder.
- **The commit is fixed when deciding.** The hub fetches the local branch into the staging repository (below) before it decides, and records the commit it points to. It then pushes that commit, `<commit>:refs/heads/<remote branch>`, never the branch as it is later. A commit the hob makes after the approval is not pushed.
- **A staging repository owned by the hub.** The hub keeps a bare repository per folder in its own data folder, with configuration only the hub writes. It fetches the branch's commits into it from the hob's folder, then pushes from it. The push itself reads no hook, configured program, filter, include or credential setting of the hob's repository.
- **The fetch runs in the hob's sandbox.** Fetching from the folder starts `git-upload-pack` inside the hob's repository. That process follows files a hob can write, such as `commondir`, `objects/info/alternates`, `info/grafts` and replace refs, any of which could point it at another repository on the hub. So the hub names its own `--upload-pack`: a wrapper that runs `git-upload-pack` in the same sandbox as the hob's turns, able to read only the hob's folders, write nothing and reach no network. Whatever the repository's files point at, the process cannot read anything outside the folders, and no check can be raced. The hub also sets `GIT_NO_REPLACE_OBJECTS=1`, and refuses a repository whose `.git` holds `commondir`, alternates, grafts or a shallow file, so a hostile layout fails early with a clear reason. Only the receiving side, writing into the staging repository, runs outside the sandbox, and it reads nothing from the hob's repository but the pack it is sent.
- **Git runs with nothing from outside.** No system or global configuration, a home folder of the hub's, `core.hooksPath` pointing at an empty hub folder, and terminal prompts off.
- **The token reaches Git only through a credential helper the hub provides, over a pipe.** It is never in an argument, an environment variable or a file.
- **Force pushes carry a lease.** A force push uses `--force-with-lease` with the commit the hub read from GitHub when it decided. A push without force never forces, so GitHub refuses it when the branch has moved.
- Only branches are pushed: never tags, deletions or other refs.
- #323 proves this against a hostile folder configuration: hooks, `core.hooksPath`, `core.fsmonitor`, `core.sshCommand`, `url.*.insteadOf`, `include.path`, `uploadpack.packObjectsHook`, `core.alternateRefsCommand`, `commondir` pointing at another repository, alternates, grafts, replace refs, credential helpers and `http.proxy`. None may run or receive the token.

### What is sent

- **Outgoing text is redacted.** Pull request titles and bodies and comments pass through the same redaction as tool output before the call is decided, so the approval card shows and approves the redacted text. The hob is told what was redacted. The content of pushed commits is not redacted; the approval card is where you check it.
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

- Push: the remote branch is at the pushed commit, so it was applied.
- Open a pull request: an open pull request from that head to that base, opened by the acting account after the call was recorded, means it was applied.
- Comment: each comment ends with a hidden marker, `<!-- hobbots-call: <nonce> -->`. The nonce is random, made by the hub for that call, and never shown to the hob. The hub strips anything shaped like a marker from the body the hob gives, with a linear-time match (STD-SEC-005). A comment by the acting account with that marker on the item means it was applied.

An applied call returns its result as success. Not finding the effect proves nothing: GitHub may still be working on a request after the hub stopped waiting for it. So a call whose effect is not found stays **uncertain**, never "not sent":

- The step shows it as uncertain, and the hob is told not to repeat it.
- The hub refuses a new call of the same action on the same site (the same branch, or the same issue or pull request) while one is uncertain, so two writes never overlap.
- The hub reads GitHub back again a few times over the next minutes. Finding the effect settles the call as applied.
- Otherwise you settle it from the step: you look on GitHub and mark it applied or not sent. Only then may the hob call again, which is decided again.
- Opening a pull request is the one exception to the refusal: GitHub refuses a second open pull request for the same head and base, so a new call cannot duplicate it.

Calls left in flight when the hub stops are uncertain when it starts, and are read back the same way.

Reads have no effect, so a failed read is reported and the hob may simply call again.

### A hob's own GitHub identity later (#221)

- **One credential service.** The Charm asks a `GitHubCredential` service for a token for each call, keyed by the hob. In this ADR it always answers with your account. A hob's own GitHub App is a second source behind the same service, chosen per hob.
- **Nothing else changes.** The actions, the policy, the repository resolution, the redaction and the failure handling stay the same for either credential.
- **Push changes inside.** With a hob's own app, Push creates commits through GitHub's API so GitHub marks them Verified ([#225](https://github.com/otaviobarros/hobbots/issues/225)). It stays the same action with the same approval.
- **Who acts is shown from the start.** The step and the approval card already say who acts on GitHub, so #221 adds a value, not a field.
- The `gh` sign-in and Git's credential stay as further sources you choose in Settings, never a silent fallback.

## Rationale

A GitHub App gives the narrowest credential GitHub offers to a desktop app that ships no secret. It is limited to the repositories you install it on and to four permissions, and it refreshes itself without asking you to sign in again for six months. The same app model is what #221 uses for a hob's own name, so the two credentials share one shape. People who are already signed in with `gh` or Git, or push with an SSH agent, can use that with one click instead of a second sign-in; the hub's repository resolution, not the credential's reach, is what keeps a hob on its own repository.

Pushing from a hub-owned staging repository to a URL the hub builds keeps workspace code out of the hub entirely. Checking each dangerous setting one by one would always miss the next one Git adds.

Asking before pull requests and comments under Balanced follows the reason pushes ask: other people see them at once. Recording each write before it is sent, and reading GitHub back after an unclear end, is what lets the hub promise that a push, a pull request or a comment is never sent twice by mistake.

## Consequences

- **#322** connects the account: the `GitHubCredential` service, the device flow, the sign-ins found on the computer, the keychain item, Settings, and the Charms tab grant. It removes the borrowed token.
- **#323** builds Push: the staging repository, pushing over SSH with your agent, the credential helper, the once-only rules, `git push` steering, hub tools that can ask, the Charm call records with their keys (migration 0029), and reconciliation.
- **#324** builds Open pull requests and Comment on GitHub on the same call records, with outgoing redaction and the comment marker.
- **#325** proves the feature end to end against a fake GitHub API with the fake runtime.
- The permissions contract adds the two new operations and points here.
- Registering the public Hobbots GitHub App is a step for the project's maintainer. Until it exists, tests use the fake GitHub API and `HOBBOTS_GITHUB_TOKEN`.
- A hob cannot fetch from a private repository. A push refused because the branch moved needs you, until a Fetch action exists.

## Validation

The scenarios that would show this decision holds. Each names the test case that checks it, or the issue that will.

- The read actions reach only the repository of the hob's own folders, never under Never and never from a folder outside them; no input widens a search; what GitHub returns is redacted: `[TC-PE-130]`, `[TC-PE-131]`, `[TC-PE-132]`, `[TC-PE-133]`, `[TC-PE-134]`.
- You connect GitHub with the device flow, Settings shows the account, its repositories and its permissions, and the token is only in the keychain. Choosing the `gh` sign-in or Git's credential instead takes one click, says it reaches every repository, and stores nothing. After you disconnect, or GitHub refuses the refresh, no hob is offered the Charm from its next turn. Not proven yet: [#322](https://github.com/otaviobarros/hobbots/issues/322).
- A hob without the grant, or with the sandbox off, is offered no GitHub action. With the app, a repository the app is not installed on is refused for every action, a public one included, and uninstalling the app closes a repository within a minute. Not proven yet: [#322](https://github.com/otaviobarros/hobbots/issues/322).
- Under Balanced a hob pushes a branch after your approval. A push with force, or to the default branch, asks as high risk and is never granted. A `git push` command is refused with a pointer to `github_push`. Not proven yet: [#323](https://github.com/otaviobarros/hobbots/issues/323).
- With the SSH option on, an approved push goes over SSH through your agent to the repository the hub resolved, and no setting from the hob's repository changes the host or command. Not proven yet: [#323](https://github.com/otaviobarros/hobbots/issues/323).
- An approved push sends the commit the card showed, even when the hob commits again before it runs, and a branch name shaped like an option is refused. Not proven yet: [#323](https://github.com/otaviobarros/hobbots/issues/323).
- An approved push runs no hook or configured program from a hostile folder configuration, the source-side fetch runs in the hob's sandbox so a `commondir` or alternates pointing outside its folders reads nothing there, a repository with `commondir`, alternates or grafts is refused, and the token reaches no process the hob can see. Not proven yet: [#323](https://github.com/otaviobarros/hobbots/issues/323).
- Two calls that find an expiring token refresh it once, and the new pair is in the keychain before either call uses it. Not proven yet: [#322](https://github.com/otaviobarros/hobbots/issues/322). Not proven yet: [#323](https://github.com/otaviobarros/hobbots/issues/323).
- A push whose answer is lost settles as applied once the remote branch shows it, and otherwise stays uncertain and blocks another push to that branch until you settle it. Not proven yet: [#323](https://github.com/otaviobarros/hobbots/issues/323).
- A hob opens a pull request and comments after your approval, the card shows the exact text after redaction, and a secret in that text never reaches GitHub. A retried or uncertain call creates neither twice, a marker the hob writes into a body is stripped, and an older pull request from the same head is not taken for this call's. Not proven yet: [#324](https://github.com/otaviobarros/hobbots/issues/324).
- The whole flow runs against a fake GitHub API with the fake runtime on SQLite and PostgreSQL, a repository outside the hob's folders is refused, and no credential reaches the sandbox's environment, files or tool output. Not proven yet: [#325](https://github.com/otaviobarros/hobbots/issues/325).
