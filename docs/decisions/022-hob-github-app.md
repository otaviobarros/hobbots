# ADR 022 — A hob's own GitHub App

Status: **Accepted.** Amended by [#1321](https://github.com/otaviobarros/hobbots/issues/1321), which lets you link an app you already have. Adds a second credential to the GitHub Charm of [ADR 020](020-github-charm.md), behind its `GitHubCredential` service, so a hob can act on GitHub under its own name ([#221](https://github.com/otaviobarros/hobbots/issues/221)). Uses the Charms of [ADR 014](014-tool-policy-and-enforcement.md) and the devices of [ADR 021](021-devices-and-remote-access.md).

## Context

With the GitHub Charm of ADR 020, a hob's commits, pushes, pull requests and comments all carry your identity. On GitHub nobody can tell a hob's work from yours.

ADR 020 left room for a hob's own identity:

- The Charm asks a `GitHubCredential` service for a token for each call, keyed by the hob.
- The step and the approval card already say who acts on GitHub.
- The hub checks before every action that the repository is one the app is installed on.
- Failures are told apart, and a write whose answer is lost is read back on GitHub.

This ADR decides the second source behind that service: a GitHub App per hob.

GitHub's behaviour here comes from its documentation for registering a GitHub App from a manifest, generating a JSON Web Token (JWT) for an app, generating an installation access token, managing private keys, the Git database API and commit signature verification for bots. None of it is verified against GitHub yet; #223 to #228 do that. Two points the documentation leaves open are checked first:

- whether GitHub accepts a loopback `redirect_url` and an inactive webhook in a manifest (#223);
- whether commits an installation token creates through the Git database API are signed by GitHub and shown as Verified, since the documentation names the Commits API as its example (#225).

## Decision

### Words used here

- **Your account** is the credential of ADR 020: the Hobbots GitHub App signed in as you, or a sign-in already on the computer.
- **The hob's app** is a GitHub App made for one hob, owned by your personal GitHub account.
- **The hob's bot** is the account GitHub gives that app, such as `frodo-hobbots[bot]`.

### One app per hob

- **Each hob gets its own app.** A hob's app is never shared with another hob. Its name, its bot and its installations belong to that hob alone.
- **Separate from the Hobbots app.** The public Hobbots GitHub App of ADR 020 connects your account. A hob's app is a private app created under your account, so it ships no secret and the Hobbots project holds nothing for it.
- **Your account stays the quick start.** Every hob uses your account by default. You give a hob its own app from its Charms tab. The GitHub Charm grant and its policy do not change.
- **Chosen per hob, never a fallback.** The `GitHubCredential` service answers with the hob's app when the hob has one, and with your account otherwise. When the hob's app cannot act, because its key was revoked or it is not installed on the repository, the action fails and says so. The hub never falls back to your account for that hob.
- **Owned by your personal account.** GitHub installs a private app only on the account that owns it. So a hob's app reaches only repositories your personal account owns. Organization repositories need an organization-owned app, which stays out of scope.

### Creating the app from a manifest

You never create an app by hand or handle a key file, unless you link an app you already have (below). Connecting a hob's app (#223) works like this:

1. In the hob's Charms tab, **Give it its own GitHub app** opens a hub page in your default browser, where you are signed in to GitHub.
2. That page posts the manifest to `https://github.com/settings/apps/new?state=<state>`. GitHub shows the app's name, which you can change, and its permissions.
3. You click Create. GitHub redirects to the manifest's `redirect_url` on the hub with a temporary `code` and the same `state`.
4. The hub checks the state, then exchanges the code with `POST /app-manifests/{code}/conversions`. GitHub allows this for one hour.
5. The hub keeps the app's ID, client ID, slug and owner, and writes the private key to the keychain (below). It then looks up the bot's user ID with `GET /users/<slug>[bot]`, for the commit identity.
6. The page links to the app's installation page, where you pick the repositories the hob may use. The Charms tab then lists them.

**The manifest:**

| Field | Value |
|---|---|
| `name` | `<hob name>-hobbots`, cut to GitHub's 34 characters. You can change it on GitHub before you click Create. |
| `url` | `https://hobbots.app` |
| `description` | Says the app is the hob's identity on GitHub, made by Hobbots. |
| `public` | `false` |
| `default_permissions` | The permissions of ADR 020's app, and nothing else: Metadata read; Contents, Issues and Pull requests read and write; Checks, Actions and Commit statuses read; Workflows write. |
| `default_events` | None |
| `hook_attributes` | `active: false`, with `url` set to `https://hobbots.app`, since GitHub requires one. If #223 finds that GitHub accepts a manifest without `hook_attributes`, it is left out instead. |
| `redirect_url` | The hub's callback on loopback (below) |
| `callback_urls`, `setup_url`, `request_oauth_on_install` | Not set. The hob's app never acts as you, so it needs no user sign-in. |

**What the hub keeps from GitHub's answer.** The conversion returns the app's `id`, `slug`, `client_id`, `client_secret`, `webhook_secret`, `pem` and owner. The hub keeps the `pem` in the keychain and the rest of the identity in the database. It discards `client_secret` and `webhook_secret` at once: the app has no user sign-in and no webhook. None of them is logged.

**The state.** The hub makes the state from 32 random bytes from the system's secure random source. It is bound to the hob and the device that started it, used once, and expires after an hour, the same window GitHub gives the code. The hub stores only its hash.

### Linking an app you already have

Making an app from a manifest stays the default. Someone who already has a GitHub App, such as one they made by hand for a bot or one an organization made, can give it to a hob instead ([#1321](https://github.com/otaviobarros/hobbots/issues/1321)):

1. In the hob's Charms tab, **Use an app you already have** opens a form.
2. You give the app's client ID, which GitHub recommends for signing, or its app ID, and its private key. You paste the key, or pick the `.pem` file GitHub downloaded. The browser reads the file; it is never uploaded anywhere but the hub.
3. The hub signs a JWT with that key, with the ID as `iss`, and reads `GET /app`. GitHub answers only for the key's own app, so this proves the key and gives the app's ID, client ID, slug, owner and permissions. The hub then looks up the bot's user ID, as above.
4. The hub writes the key to the keychain, then gives the hob the app, exactly as for a made app. The hub keeps it as `linked`.
5. The Charms tab lists where the app is installed. You never type an installation ID.

- **From the hub's own computer only.** The key is sent to the hub once. The hub's status for a hob with no app says whether this browser can link one: only a browser at the hub's loopback address can, like starting a manifest. A browser anywhere else, including one through `tailscale serve`, is never offered the form, so it never sends a key across the network, and the hub refuses a key that reaches it from there anyway. The API decodes it straight into a redacted value, and the hub redacts it by value before anything else reads it. In the browser, the request takes the key out of what it was given as it sends it, so the query library's record of the request never holds it afterwards, whether the hub linked the app or refused it. The form forgets the key once the app is linked; after a refusal it keeps what the user typed, so they can correct the ID or the key and try again.
- **What it refuses**, each with its own reason the Charms tab words: an ID that is no app ID or client ID, a key the hub cannot read, a key GitHub does not take for that app, an app another hob already has, left over or not, and the refusals of making an app (retired, already has one, an old app left over, no keychain).
- **Missing permissions are said, not refused.** The app may have fewer permissions than a made app's. The hub links it and the Charms tab names the missing ones, so you can add them on GitHub. Each installation the hub lists says which permissions it does not grant, as GitHub lists them, and while the app is installed nowhere the hub reads what the app itself lacks from `GET /app`. So the Charms tab still names them when it is opened again, and stops once the app has them and its installation's owner accepts them. Until then, the actions that need them fail when GitHub refuses their token.
- **Any owner.** A linked app can be owned by an organization. Its installations are found the same way, and each token still names one repository of one installation.
- **Unlinking keeps the app as it is.** The hub did not make a linked app, so it does not take it apart. Disconnecting it, or retiring the hob, deletes its key from the keychain and forgets it, and revokes the hob's GitHub grants as above. It leaves the app's installations on GitHub, and links to no page that deletes the app.
- **A refused key is fixed by linking again.** When GitHub no longer accepts a linked app's key, the Charms tab offers to link the app again with a new key, not to make a new app.

### How the redirect reaches the hub

- **Loopback first.** The `redirect_url` is `http://127.0.0.1:<port>/github/hob-app/callback`, at the hub's current port. A browser on the hub reaches it, so creating a hob's app works from the hub's window and from a browser on the hub.
- **No device needed for two routes.** Your default browser may not be an approved device (ADR 021). So the page that posts the manifest and the callback answer without a device, like pairing. Each acts only for a valid, unused state, and answers `404` otherwise. They share pairing's rate limits for requests without a device. They answer only local requests.
- **Not yet from other devices.** On a connected desktop or a browser on the tailnet, the Charms tab says to give the hob its own app from the hub's computer. Once remote access is in place (ADR 021, [#14](https://github.com/otaviobarros/hobbots/issues/14)), a follow-up can set the `redirect_url` to the hub's HTTPS address through `tailscale serve`, so a browser on another device can finish the flow. That is out of scope here.
- **The port only matters during creation.** The app keeps no URL that points at the hub, so changing the hub's port later does not break it.

### The private key

- **In the keychain on the hub.** The private key is one item in the OS keychain per hob: the macOS Keychain, or the Secret Service on Linux, through the same keychain access as ADR 020. Like the sign-in, the keys are the hub's own, under a service named after its data folder (`ai.hobbots.hub-<id>.github.hob-app`), and a hub moves the key of each hob with an app out of the service every hub shared before ([#1214](https://github.com/otaviobarros/hobbots/issues/1214)). It never goes on a command line, in the database, the event journal, logs, the browser or the sandbox. Without a usable keychain the hub refuses to create the app rather than write the key to a file.
- **Written before it is used.** The hub writes the key to the keychain before it marks the hob's app connected. If the write fails, the Charms tab says so and links to the app's settings page on GitHub, so you can delete the app GitHub already made.
- **Redacted by value.** The key, every JWT and every installation token join the known values the hub redacts (permissions contract). Private key blocks are already redacted by shape.
- **No key files to make an app, and no rotation.** GitHub keys do not expire. Making an app never asks for a key file. If a key is revoked or lost, you reconnect, which creates a new app, or links a linked app again with a new key.
- **Removed with the hob's app.** Disconnecting the hob's app, or retiring the hob, does this:
  1. With a JWT, the hub removes the app's installations (`DELETE /app/installations/{installation_id}`), so the app can no longer reach your repositories even if the key leaked earlier. A failure here is shown, not retried in a loop. The hob's app is then kept as left over: it no longer acts, and the Charms tab shows what could not be removed with the link below until you dismiss it, so a failure during retirement is not lost.
  2. It deletes the keychain item.
  3. It links to the app's advanced settings page on GitHub, where you can delete the app itself. GitHub's documentation offers deleting an app registration only there.
- **The hob goes back to your account.** After a disconnect the hob acts as you again, once its Charm grant and policy allow it. The hob's grants for GitHub actions are revoked (ADR 015), so nothing approved while it acted as its bot runs as you. Connecting an app revokes them the same way, so nothing approved while it acted as you runs as its bot. The switch is one step: the hub counts it, revokes those grants and makes the hob act as the other identity together, only once the app is saved or its removal is done. A request for a GitHub write records the identity its call chose its credential under, and when it is decided after the switch it expires instead, Once or Always, so it saves no grant for the other.

### Tokens: short-lived and minted on demand

The hub mints tokens itself (#224). You never sign in again while the app stays installed.

- **The JWT.** The hub signs a JWT with the hob's key using `RS256`. Its `iss` is the app's client ID, as GitHub recommends. Its `iat` is 60 seconds in the past, against clock drift, and its `exp` is 9 minutes in the future, inside GitHub's limit of 10. The hub makes a new JWT whenever it needs one and never stores it.
- **Finding the installation.** The hub finds the installation for a repository with `GET /repos/{owner}/{repo}/installation` and the JWT. A `404` means the app is not installed there: the action is refused with "<hob>'s app is not installed on this repository" and a link to change that. This is ADR 020's installed-repositories check for the hob's app, cached for at most a minute the same way.
- **One repository, the action's permissions.** The hub asks for each installation token with `POST /app/installations/{installation_id}/access_tokens`, naming exactly one repository by name in `repositories` and only the permissions the action needs. The name is enough, since the app's installations are all on your account, and saves a request for the repository's ID. Metadata read is always included, as GitHub grants it to every token:

  | Action | Permissions asked for |
  |---|---|
  | View, find and read (#317) | Metadata, Contents, Issues and Pull requests read; Checks, Actions and Commit statuses read |
  | Push | Contents write; Workflows write only when the pushed commits change `.github/workflows` |
  | Open a pull request | Pull requests write, Contents read |
  | Comment | Issues write, Pull requests write |

- **Cached in memory only.** An installation token lasts one hour. The hub keeps it in memory, keyed by hob, repository and permissions, and replaces it on the next use once less than five minutes are left. Only one token is minted at a time for one key. Tokens never go in the keychain, the database or anything else ADR 020 keeps them out of.
- **Never in the sandbox.** Tokens reach Git only through the hub's credential helper over a pipe, as in ADR 020.

### Who acts, and what fails

- **The "who acts" value.** The step and the approval card say "as <hob>'s app, <slug>[bot]" for the hob's app, and "as you" with your login otherwise. Switching the hob's credential while a card waits stops the call, as connecting another account does in ADR 020. Calling again asks again.
- **The failure cases of ADR 020 stay**, with one change. For the hob's app, Signed out means: on a `401` with an installation token, the hub mints a new token and sends once more; a second `401` marks the hob's app as needing a reconnect. A `401` while signing in with the JWT also marks it, without retrying, since only a revoked key or a deleted app causes it once the clock is right.
- **Needing a reconnect.** The keychain item stays until you act, so a clock problem does not lose the key. The Charms tab shows the hob's app as needing a reconnect, with one action to fix it: reinstall the app when it was uninstalled, or create a new app when the key was revoked or the app deleted. The hob's GitHub actions fail with that reason until then. They never run as you instead.
- **Reconciling.** Reading GitHub back after an uncertain call works as in ADR 020, with the bot as the acting account.

### Commit identity

- **Local commits as the bot, by default.** A hob with its own app commits as its bot. The launcher sets `user.name`, `author.name` and `committer.name` to `<slug>[bot]`, and `user.email`, `author.email` and `committer.email` to `<bot user ID>+<slug>[bot]@users.noreply.github.com`. It passes them through `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n` and `GIT_CONFIG_VALUE_n`, the variables Claude Code's scrub keeps (ADR 014). Settings passed this way win over your Git config and the repository's, `author.*` and `committer.*` included.
- **Identity variables are removed.** `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` and `EMAIL` would win over any setting, so the launcher removes them from the turn's environment for a hob with its own app.
- **A default, not a guarantee.** A hob can still name another identity in its own command, with `--author`, `-c user.name=…` or one of those variables. That changes only its local history: Push recreates every commit as the bot without its author (below), so what reaches GitHub is always the bot's.
- **A hob on your account** keeps your identity, as #218 set it.
- **No signing with your key.** The switch that lets a hob sign commits with your 1Password key (ADR 014, #234) is off and hidden for a hob with its own app. Your key should never vouch for a bot's commits, and GitHub signs them on the way out (below).

### Push creates commits through GitHub's API

With the hob's app, Push stays the same action, with the same policy, the same once-only rules and the same approval card (#225). Only what happens when it is sent changes:

1. **The commit is fixed when deciding**, in the staging repository, exactly as in ADR 020. The hub reads the remote branch then too.
2. **The commits to send** are those reachable from the fixed commit that GitHub does not have. A commit GitHub already has is one reachable from a branch the staging repository fetched from GitHub, or one this hob already sent, which the staging repository maps to the commit GitHub made from it.
3. **The hub recreates each one on GitHub, oldest first**, with the Git database API and the hob's installation token: a blob for each file that changed, a tree from the parent's tree with those entries (file modes, symbolic links and submodules kept), then a commit with the same message and mapped parents. It sends no author, committer or signature, so GitHub signs the commit as the hob's bot and marks it Verified.
4. **The branch moves with Git, not the API.** The hub fetches the new commits into the staging repository, then pushes the last one with ADR 020's Git push from staging: plain for a normal push, which GitHub refuses when the branch moved, and with `--force-with-lease` for a force push. The Git database API has no lease for a forced ref update, so the branch is never moved through it.
5. **The result** gives the hob both IDs for each commit, since GitHub's differ from its own. The staging repository keeps the map, so the next push sends only newer commits.

- **The card says it.** For the hob's app, the card adds that GitHub creates new commits signed as the bot, with new IDs and dates.
- **Nothing is published until the branch moves.** Creating blobs, trees and commits stores objects on GitHub but changes no branch. A failure before step 4 is reported as "Not sent" with that difference from ADR 020 stated: no branch changed, but objects already created may remain on GitHub, unpublished, until GitHub cleans them up. Calling again recreates them and never moves a branch twice. Only the Git push in step 4 can be uncertain, and it is read back as ADR 020 says: the remote branch at the last new commit means it was applied.
- **Limits.** GitHub's limits apply: a file over 100 MB is refused. A push that needs more requests than the installation has left this hour is refused before anything is sent, and says when to try again.
- **A rewritten history needs force.** If the hob rewrites commits it already sent, the map no longer reaches its branch, and GitHub refuses the push as not a fast-forward. The hob asks for a push with force, which is high risk as before.

### What stays out

- **Making organization-owned apps.** They need an organization owner's approval. Later. An organization's app that already exists can be linked.
- **Webhooks.** A hob reacting to GitHub events needs a public address and a webhook secret. Later.
- **Apps shared by several hobs.** One app is one hob's name, linked or made.
- **The redirect from other devices** (above).
- **The hob's app acting as you.** No user access token is ever made for it.
- **Deleting the app from the hub.** You delete an app on GitHub. A key file is asked for only when you link an app you already have.

## Rationale

A GitHub App is how GitHub gives a program its own name, with its own permissions and installations, without another user account to manage. An app per hob keeps each hob's work, permissions and installations apart, and uninstalling one closes one hob only. The manifest flow removes the two steps people get wrong, filling in the app's settings and moving a key file, and ships no secret, since the app is yours.

Installation tokens last an hour and are minted from the key on the hub, so the hob never needs you to sign in again. Scoping each token to one repository and the action's permissions means a token that leaked would reach little for little time. Keeping the key in the keychain, and never falling back to your account, keeps the rule of ADR 020 that a hob acts only under the credential you chose for it.

Creating commits through the API is what GitHub signs for a bot, so the hob's work shows as verified without any key of yours. Moving the branch with Git from the staging repository keeps ADR 020's lease and refusals, which the API's ref update cannot give. The cost is that the commits get new IDs, which the hob is told.

Loopback is enough for the first version, because the hub's computer is where you set hobs up today. The tailnet address can replace it once remote access exists, without changing the app.

## Consequences

- **#223** creates a hob's app from the manifest: the hub pages and the callback, the state, the conversion, the keychain item, the bot's user ID and the listing of installations.
- **#224** mints JWTs and installation tokens as the `GitHubCredential` source for the hob's app, with the installation check, the in-memory cache and the reconnect state.
- **#225** builds Push for the hob's app: commits through the Git database API, the map in the staging repository, the bot's local identity and hiding the signing switch.
- **#226** opens pull requests and comments as the hob's bot.
- **#227** builds the hob's Charms tab: give it its own app, its installed repositories, reconnect and disconnect. It follows the design reference and updates it in the same change.
- **#228** proves the feature end to end against the fake GitHub API of #325.
- The fake GitHub API grows the manifest conversion, the app and installation endpoints, the Git database endpoints and a signed-commit flag.
- The permissions contract points here for the hob's app.
- A hob with an app made from a manifest reaches only repositories your personal account owns. A linked app reaches wherever it is installed.
- **#1321** links an app you already have: the form, the check with GitHub, the keychain item, and unlinking without touching its installations.
- A hob's commits on GitHub have different IDs from its local ones until a Fetch action lets it catch up.

## Validation

The scenarios that would show this decision holds. Each names the issue that will prove it.

- You give a hob its own app without handling a key file: the manifest opens on GitHub with the hob's name and the permissions above, the hub exchanges the code within the hour, the key is only in the keychain, and the secrets GitHub also returns are never stored. A state used twice, expired or made for another hob does nothing. Without a keychain the hub refuses. Proven against the fake GitHub API with the in-memory keychain: `[TC-GEN-051]`, `[TC-GEN-053]`, `[TC-PE-250]` to `[TC-PE-255]`, and a platform without a usable keychain: `[TC-PE-257]`. End to end over the hub's API, from the hub's page and GitHub's redirect to the Charms tab listing the installation: `[TC-GEN-110]`. Not proven yet against GitHub itself, including whether it accepts the loopback `redirect_url` and the inactive webhook: [#420](https://github.com/otaviobarros/hobbots/issues/420).
- Disconnecting the hob's app or retiring the hob removes its installations and its keychain item, revokes grants made for the bot, and the hob then acts as you. Removing the installations and the key on disconnect and retirement, and showing what could not be removed: `[TC-GEN-052]`, `[TC-GEN-054]`, `[TC-PE-253]`, and keeping it shown when retirement could not remove it: `[TC-GEN-055]`, `[TC-PE-256]`. Revoking the hob's GitHub grants on both connect and disconnect, before its identity changes: `[TC-GEN-064]`, and expiring a request asked before the switch instead of saving its grant, including one asked as the bot while its removal was under way: `[TC-GEN-067]`, `[TC-GEN-068]`. The Charms tab disconnecting it after asking, linking to delete it on GitHub, and showing and dismissing an app left over, in a browser with the hub's answers stood in: `[TC-GEN-058]`. End to end, the hob's next comment after a disconnect asking and going out as you, with no token asked of the app, and retiring a hob removing its app's installations and key: `[TC-GEN-117]`.
- Each token is scoped to one repository and the action's permissions, from a JWT that lasts at most 10 minutes, and the hob reads and comments as its bot. A token is replaced five minutes before it expires without asking you. A repository the app is not installed on is refused before a token is asked for. Two calls at once mint one token. Calls GitHub refused the same token at once get one new token, minted once. A call checked under the hob's app stops when the app is disconnected meanwhile, a push's retry included, and never goes out over your SSH key. Proven against the fake GitHub API: `[TC-GEN-059]`, `[TC-GEN-060]`, `[TC-GEN-061]`, `[TC-GEN-064]`, `[TC-GEN-065]`, `[TC-GEN-066]`. End to end, with the hub's clock and GitHub's moved an hour ahead: the hob's next read gets a new token from a new JWT, never sends the lapsed one, asks nothing and needs no sign-in: `[TC-GEN-114]`. Not proven yet against GitHub itself: [#420](https://github.com/otaviobarros/hobbots/issues/420).
- A revoked key or an uninstalled app fails clearly, marks the hob's app as needing a reconnect, sends nothing more until the user acts, and never falls back to your account. Proven against the fake GitHub API: `[TC-GEN-062]`, `[TC-GEN-063]`, and the Charms tab showing it with its one fix, in a browser with the hub's answers stood in: `[TC-GEN-057]`. End to end, a revoked key marking the app on the Charms tab and the hob's next read and comment reaching GitHub no more: `[TC-GEN-116]`. An app uninstalled on GitHub failing the hob's next action with where to install it again, after one more token and never as you, and marking the app for reinstalling on the Charms tab so its next action reaches GitHub no more: `[TC-GEN-115]`. GitHub refuses to mint an uninstalled app's token rather than refusing the token, so the hub marks the app when an app it has seen installed is installed nowhere any more, whether it learns that while minting or while finding the repository's installation: `[TC-GEN-155]`. An app still installed elsewhere is not marked, and only that repository is refused: `[TC-GEN-156]`.
- A hob with its own app commits locally as its bot, with author and committer both the bot, even when your Git config or the repository's sets `user.*`, `author.*` or `committer.*` and the hub's environment sets `GIT_AUTHOR_*`, `GIT_COMMITTER_*` or `EMAIL`. A commit the hob makes with `--author` reaches GitHub as the bot's after Push. It cannot sign with your key, and none of your signing setup reaches it, so a commit it forces to be signed with `-S` fails without starting your signer, such as 1Password's. Its instructions say it commits unsigned as its bot and that GitHub signs on push. Proven with Git and the hub's turn settings: `[TC-CH-194]`, `[TC-CH-195]`, `[TC-CH-196]`, `[TC-CH-198]`, `[TC-CH-199]`, `[TC-CH-200]`, and end to end from the turn the hub gives the hob, over the user's and the repository's identity: `[TC-GEN-110]`, and on GitHub's side against the fake GitHub API: `[TC-GEN-087]`. Inside the macOS sandbox: `[TC-CH-197]`. Not proven yet: hiding the signing switch on the hob's profile.
- An approved push creates commits that GitHub shows as the bot's and Verified, moves the branch with Git so a moved branch is refused and a force push keeps its lease, and a second push sends only newer commits. A failure before the branch moves changes no branch, and calling again moves it once. Proven against the fake GitHub API, whose signed-commit flag stands in for GitHub's signature: `[TC-GEN-087]` to `[TC-GEN-091]`. A retry after GitHub made the commits but before the branch moved still asks for Workflows when they change one: `[TC-GEN-097]`. The branch moves only once the hub has saved which commits GitHub made, in one transaction: `[TC-GEN-098]`. End to end over the hub's API, after a card that names the bot: `[TC-GEN-111]`. Not proven yet against GitHub itself, including whether GitHub signs commits an installation token makes through the Git database API: [#420](https://github.com/otaviobarros/hobbots/issues/420).
- A hob opens a pull request and comments as its bot, with the same policy and card, which name the bot as who acts. Opening a draft pull request and commenting as the bot, each with a token for that action alone, never the user's account, and a card and step that say "as Frodo's app, frodo-hobbots[bot]": `[TC-GEN-092]`, `[TC-GEN-093]`. The hob's policy unchanged, with the step alone naming the bot when nothing asks: `[TC-GEN-094]`. A card that waits while the app is disconnected sends nothing, and calling again asks again as you: `[TC-GEN-095]`. A lost answer read back as the bot's, never the user's pull request from the same head: `[TC-GEN-096]`. Proven against the fake GitHub API with the in-memory keychain, and end to end over the hub's API, with a hob without its own app still acting as you: `[TC-GEN-112]`, `[TC-GEN-113]`. Not proven yet against GitHub itself: [#420](https://github.com/otaviobarros/hobbots/issues/420).
- The Charms tab gives a hob its own app, lists where it is installed, and fixes a reconnect in one action. Proven in a browser against a hub from source, with GitHub's page stood in and, once the app exists, the hub's answers about it stood in: `[TC-GEN-056]`, `[TC-GEN-057]`, including the tab reading the app's status again after reading its installations marks it: `[TC-GEN-057]`. The hub names the repositories each installation reaches from `GET /installation/repositories`, with one token per installation that reads metadata only and is kept until five minutes before it lapses: `[TC-GEN-084]`. Removing the installations needs only their IDs, so names GitHub will not give never keep an installation in place on disconnect or retirement: `[TC-GEN-085]`. Not proven yet: the flow against GitHub itself ([#420](https://github.com/otaviobarros/hobbots/issues/420)).
- You link an app you already have by its ID or client ID and its key: the hub checks the key with GitHub, keeps it only in the keychain, redacts it, lists the app's installations, and says which permissions it lacks. It refuses a wrong ID or key, an app another hob has and a hob that cannot take an app, keeps nothing when it refuses, and takes the key only from the hub's own computer, whose browser alone is offered the form. Unlinking or retiring the hob deletes the key and leaves the installations. Proven against the fake GitHub API with the in-memory keychain: `[TC-GEN-405]`, `[TC-PE-520]`, `[TC-GEN-406]`; the stored origin and the app's holder on SQLite and PostgreSQL: `[TC-GEN-407]`; over the hub's API: `[TC-PE-521]`; the browser keeping no copy of the key it sent: `[TC-PE-522]`; and the Charms tab's form, a refusal by its field, the missing permissions after opening it again, no form for another computer, and unlinking, each scanned for accessibility, in a browser with the hub's answers stood in: `[TC-GEN-408]`. Not proven yet against GitHub itself: [#420](https://github.com/otaviobarros/hobbots/issues/420).
- End to end against the fake GitHub API with the fake runtime, a hob pushes and opens a pull request as its bot with verified commits, and no key or token reaches the sandbox's environment, files or tool output. Proven over the hub's API with its own composition: `[TC-GEN-110]` to `[TC-GEN-113]`, and the app's key, its JWTs and its tokens found nowhere in the sandbox's environment, any file on the hub, any table or any API answer: `[TC-GEN-118]`. Not proven yet against GitHub itself: [#420](https://github.com/otaviobarros/hobbots/issues/420).
