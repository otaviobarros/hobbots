# ADR 014 — Tool policy and enforcement

Status: **Accepted.** Refines the [permissions contract](../architecture/permissions.md) and the [runtime adapters](../architecture/runtime-adapters.md) for Slice 7, and closes the open preset mapping of [ADR 003](003-autonomy.md).

## Context

Hobs only chat today: the Claude Code adapter starts the runtime with no tools. Slice 7 lets them read, edit and run things in the folders the user chose. The permissions contract already decides the principles (Allow / Ask / Deny on a normalized operation, a prompt is not a boundary, an adapter declares what it can enforce and anything it cannot is blocked), but left open:

- which operations exist in the MVP and how Careful, Balanced and Trusting map onto them;
- how folders are shared between hobs;
- which mechanism enforces the policy, and whether it also works for Codex and OpenCode later;
- how capabilities that act beyond the folders (web search, purchases, phone calls, computer use) fit, and what the UI calls them;
- whether the sandbox can be turned off.

The evidence used here is the current Claude Agent SDK documentation (permission evaluation, `PreToolUse` hooks, `canUseTool`, `sandbox`, `settingSources`, `spawnClaudeCodeProcess`), the Codex documentation (its own `read-only`, `workspace-write` and `danger-full-access` sandbox modes on Seatbelt and bubblewrap) and the README of Anthropic's open-source [sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime). None of it is verified against the installed versions yet; #131 and #137 do that.

## Decision

### Operations

The policy engine decides these operations for the MVP. Every runtime tool call and every sandbox network request is normalized into one of them before it is decided.

| Operation | What it covers | Enforced by |
| --- | --- | --- |
| Read files | Reading and searching files in the hob's folders | Policy hook for file tools; sandbox for commands |
| Create and edit files | Writing, creating and renaming files in the hob's folders | Policy hook; sandbox |
| Delete files | Removing files in the hob's folders | Policy hook for file tools; recognized delete commands (checked, see below) |
| Run commands | Shell commands, tests and builds | Policy hook; the command runs in the sandbox |
| Local Git | Status, diff, log, branch, commit, stash and other Git work that stays on the hub | Runs as a command, in the sandbox |
| Push | Sending commits to a remote | A Charm on the hub (see below); the sandbox holds no Git credentials, so pushes needing them go only through the Charm (checked for remotes that accept pushes without credentials, see below) |
| Use the web | Fetching pages and reaching hosts from commands (package installs, downloads) | Sandbox network proxy, decided per host |
| Anything outside the hob's folders | Reading or writing any other path on the hub | Sandbox (deny); policy hook |

A rule is **enforced** when a runtime or OS boundary holds it whatever the hob does, and **checked** when Hobbots recognizes the operation and decides it but a determined command could perform it another way. Two rules are checked. **Delete files:** a command allowed to run can delete files inside the hob's folders without saying so. **Push to a remote that needs no credentials:** where Run commands and Use the web are both Allow, a command can push to a host that accepts anonymous pushes (Git's `http.receivepack`), bypassing the Push Charm and its once-only approvals; the sandbox's proxy sees only the host, not the Git request. Pushes to remotes that need credentials stay enforced, because only the Charm holds them, and under Careful a new host still asks first. The sandbox still guarantees nothing outside the folders is touched, and the Permissions tab marks both rules as checked. Every other rule in the table is enforced.

### Preset mapping

Allow proceeds without asking, Ask pauses the turn for an approval, Deny refuses (the UI says **Never**).

| Operation | Careful | Balanced (Trusted Workspace) | Trusting |
| --- | --- | --- | --- |
| Read files | Allow | Allow | Allow |
| Create and edit files | Ask | Allow | Allow |
| Delete files | Ask | Ask | Allow |
| Run commands | Ask | Allow | Allow |
| Local Git | Ask | Allow | Allow |
| Push | Ask | Ask | Allow |
| Push with force, or to the default branch | Ask (once only) | Ask (once only) | Ask (once only) |
| Use the web | Ask, per host | Allow | Allow |
| Anything outside the hob's folders | Deny | Deny | Deny |

- Under Careful, Local Git asks because it is a command; reading needs no approval so investigation stays automatic, as the contract requires.
- Balanced matches PE-001: reads, edits, tests, builds, local Git and delegation run without asking; deleting and pushing wait for the user.
- Trusting still keeps every hob inside its folders and the sandbox, and still asks for force pushes and pushes to the default branch. It never grants self-approval or Hobbots administration.
- Hosts that are never reachable from the sandbox under any preset: loopback (the hub's own API included), link-local and cloud metadata addresses. The runtime's own model API host is always reachable, because the runtime needs it to think.
- Per-hob overrides only narrow this table (#130). A widening needs a separately recorded user grant.

**Onboarding wording.** The Safety step shows these rows with the preset's answers, so the summary and the policy cannot drift:

| Row | Careful | Balanced | Trusting |
| --- | --- | --- | --- |
| Read your folders | Allow | Allow | Allow |
| Create and edit files | Ask | Allow | Allow |
| Delete files | Ask | Ask | Allow |
| Run commands | Ask | Allow | Allow |
| Use the web | Ask | Allow | Allow |
| Push your work | Ask | Ask | Allow |
| Anything outside your folders | Never | Never | Never |

| Preset | Card note | What the Elder Hob says |
| --- | --- | --- |
| Careful | Reads freely and asks before changing anything. Good for your first week. | Careful it is. Your hobs read your folders on their own and ask before they change, run or fetch anything. |
| Balanced (recommended) | Works freely in your folders. Deleting and pushing wait for you. | Balanced is what most people pick. Your hobs edit, run and browse in your folders on their own, and ask before deleting or pushing. |
| Trusting | Gets on with chores and tells you after. Best for hobs you know well. | Trusting! Your hobs just get on with it, pushes included. They still stay inside your folders. |

The rows "Send messages" and "Pay for things" leave the Safety step: they are Charms, which no hob has in the MVP. Each Charm states its own answer when it arrives.

### Folders

- The folders approved in setup are **shared folders**: every hob can work in them.
- Each hob can have **its own folders** on top, added by the user in the hob profile. A hob's effective folders are the shared folders plus its own, minus any shared folder a per-hob override hides. A hob cannot add a folder to itself.
- Paths are compared in canonical form: absolute, with `.` and `..` resolved and every symlink resolved (`realpath`). A path that does not exist yet, such as a file about to be created, is canonicalized through its nearest existing parent. Comparison follows the volume's case sensitivity, so on a case-insensitive macOS volume `~/Code` and `~/code` are the same folder. A path is inside a folder only if its canonical form equals the folder or starts with the folder followed by a separator.
- Folders are stored canonical. A symlink inside a folder that points outside it is outside.
- Inside a folder, `.git/hooks` and `.git/config` are read-only for hobs, because a hook or config a hob writes would later run outside the sandbox when the user runs Git. This protects the user's own Git use; it is not enough for the Push Charm, which never runs repository code (see Charms), since `core.hooksPath` can point at a writable folder such as `.husky`. Commits, branches and the index still work.
- The Hobbots data folder (database, backups, logs) is never readable or writable from the sandbox, even when a shared folder contains it.

### Enforcement

Two layers enforce the policy, and both are required for tools to be offered.

**1. The runtime's permission hooks.** For Claude Code:

- `settingSources: []` and `strictMcpConfig: true`, so no settings, permission rules or MCP servers are loaded from disk; Hobbots passes everything explicitly.
- `permissionMode: "default"` and no bare tool names in `allowedTools`. Tools the policy denies outright go in `disallowedTools`, which wins over everything.
- A **`PreToolUse` hook** matching every tool is the decision point. It runs before the rest of the SDK's permission flow, so it sees calls Claude Code would otherwise approve on its own, such as reads in the working directory and read-only commands, which never reach `canUseTool`. The hook calls the policy engine with the normalized operation and canonical target and returns `allow`, `deny` with a reason, or `ask`.
- `canUseTool` only waits for approvals: an `ask` from the hook routes the call to it, and it holds the turn until the user answers (#133). It also receives the few protected actions the SDK never lets a hook auto-approve, which it decides through the policy engine like any other call.
- `cwd` is the hob's first folder and `additionalDirectories` the rest.
- Claude Code's own `sandbox` option stays off: Hobbots' sandbox already wraps the whole process, and macOS Seatbelt profiles cannot nest.

Codex and OpenCode adapters do the same with their approval hooks, with their own sandboxes set to full access inside Hobbots' sandbox for the same reason.

**2. One OS sandbox around the whole runtime process.** Hobbots starts the runtime process inside Anthropic's sandbox-runtime (`@anthropic-ai/sandbox-runtime`): Seatbelt on macOS, bubblewrap with a network namespace and seccomp on Linux. For Claude Code the adapter does this through `spawnClaudeCodeProcess`; for Codex, through the command that starts its app server. The sandbox configuration is generated for each turn from the effective policy:

- **Reads:** the user's home and other user data are denied, the hob's folders are allowed, and so are the system and toolchain paths a command needs and the runtime's own state folder. The deny region is the user's data, not the whole disk, because commands need `/usr`, `/System` and their toolchains.
- **Writes:** only the hob's folders and a private temporary folder per hob, minus the protected paths above.
- **Network:** every connection goes through sandbox-runtime's proxy. Allowed hosts come from the policy; for an undecided host the proxy asks the policy engine, which answers Allow, Deny or Ask (Careful). The model API host is always allowed and the blocked addresses above are always denied.
- **Child processes** inherit the same limits, so a script cannot step outside them.

**Why the whole process, not each runtime's own sandbox.** Wrapping the process confines file tools, commands and network with one mechanism and one policy for every runtime, so Codex and OpenCode later get the same guarantees without mapping Hobbots' policy onto three different sandbox models. Each runtime's own sandbox covers only its shell commands, differs in what it can express (Codex has three modes plus writable roots; Claude Code its own settings), and would have to be verified separately. The costs, accepted:

- sandbox-runtime describes itself as a beta research preview. Its npm releases are ordinary versions, not prerelease tags, so it follows the dependency rule, but it sits behind Hobbots' enforcement service so it can be replaced, and #131 verifies the installed version.
- The runtime's own state folder is readable inside the sandbox, so a hob could read the runtime's stored login. sandbox-runtime's credential masking is experimental; #131 records what it can hide.
- On Linux, tools that create their own sandbox (Chromium, Electron, rootless containers) fail inside, because nested user namespaces stay blocked.
- sandbox-runtime needs `ripgrep` on macOS and `bubblewrap`, `socat` and `ripgrep` on Linux. Provider health reports whether the sandbox can start.
- **Windows:** sandbox-runtime's Windows backend is alpha. On Windows, Run commands, Local Git and Use the web are blocked and labeled "Needs the sandbox" until it matures; file tools still work through the policy hook.

A sandbox that cannot start never falls back silently to running without it: the turn fails with the reason, like Claude Code's `failIfUnavailable`.

**Changing authority mid-turn.** File tools and new hosts are re-decided on every call. A change that narrows what the running sandbox allows (a removed folder, a narrowed network rule) applies through sandbox-runtime's live configuration update where #131 verifies it works, and otherwise stops the hob's running reply with the reason, so the next turn starts with the narrower sandbox.

### What #131 verified

Checked on macOS with Claude Code 2.1.301, the Claude Agent SDK 0.3.311 and sandbox-runtime 0.0.81; Linux and Windows are not verified yet.

- Under Balanced a real hob fixed a file and ran `npm test` in its folder without asking. A command writing outside the folder failed with "operation not permitted", and so did a read of a dotfile in the home folder, whatever the prompt said.
- The policy hook sees every call, including reads in the working directory. A call that would need an approval is refused with the reason until #133 adds asking.
- Claude Code needs three things inside the sandbox: its state folder (`~/.claude`, `~/.claude.json`), its temporary files in the turn's own folder (`CLAUDE_CODE_TMPDIR`; it uses `/tmp` otherwise), and only the model API hosts when `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set. Claude Code's settings, hooks, commands, agents, skills and plugins stay read-only, since a later run would load them outside any policy.
- **The keychain stays closed.** Opening the macOS keychain services to the sandbox lets any command read every credential a trusted helper can: `git credential-osxkeychain` returned the user's GitHub password and `gh auth token` succeeded. So the sandbox gets no keychain access, and the runtime gets its sign-in in its environment instead: an API key or `CLAUDE_CODE_OAUTH_TOKEN` from the hub's environment as they are, or else the claude.ai login's short-lived access token, read on the hub. The refresh token never enters the sandbox. Claude Code cannot refresh that token from inside. Before a turn the hub runs `claude auth status`, which refreshes the login once it has expired (the refreshed token lasted about eight hours), and a turn never starts with less than a minute left; a turn that outlives the token fails with Claude Code's sign-in error. A long-lived token from `claude setup-token` avoids this; a long-lived token from `claude setup-token` avoids this, and a hub-side way to keep it is a follow-up. The token is readable by commands, as the runtime's stored login already was.
- sandbox-runtime protects `.git/hooks` and `.git/config` only under the hub's own working folder on macOS, so Hobbots adds them, in each folder and in any repository below it, to the turn's write denies.
- The proxy asks about a new host without saying which turn's command asked, so Hobbots answers for every live turn at once: a host is reached only when the policy of each live turn allows it. The model API hosts are allowed per turn through sandbox-runtime's per-command lists. Commands of two hobs running at once with different web rules both get the narrower one.
- Not done in #131: the Push Charm and its hub-side Git credentials (a `git push` command is decided as Push by the hook: under Careful and Balanced it asks first, so it is refused until #133; under Trusting it runs, and fails against a remote that needs credentials, since none are in the sandbox), credential masking, live configuration updates when authority narrows mid-turn (the next turn gets the narrower sandbox), and the per-hob sandbox switch.

### Charms

A **Charm** is a connection that gives a hob abilities beyond its runtime's own tools: an integration with another app or service that lets it reach tools, do additional work and create things there. GitHub, Slack, Google Drive, Notion, Figma, any MCP server, and later web search, computer use, purchases or phone calls are all Charms.

- **Connect once, grant per hob.** The user connects a Charm on the hub once (signing in or adding a key), then grants it to each hob from that hob's Charms tab. A hob without the grant cannot see the Charm.
- **Each action has its own answer.** A Charm lists its actions, and each is Allow, Ask or Never per hob (for Slack, reading channels can be Allow while sending a message is Ask).
- **Where Charms come from.** A few are built in, and any MCP server the user adds becomes one; a catalog can come later. The MVP ships the built-in GitHub Charm with one action, Push.
- The runtime's own tools (files, commands, Git, web) are not Charms; the profile lists them as Built in.

- A Charm runs on the hub, in the Hobbots server process, **outside the runtime sandbox**. The adapter exposes it to the runtime as a tool over the runtime's own control channel (for Claude Code, an in-process MCP server from the SDK), never over the network, so the sandbox's network rules neither reach nor block it.
- Every Charm call goes through the policy engine with Allow / Ask / Never, with its exact arguments in the approval (the remote, branch and commits for Push). The sandbox confines only what the runtime does on its own; it never blocks a Charm the user granted.
- Credentials a Charm needs (Git credentials, service sign-ins and keys, payment details) stay on the hub and never enter the sandbox, so a Charm is the only route to effects that need them: a `git push` typed as a command fails against a remote that needs credentials. Effects a service allows without credentials are not covered by this, which is why Push to a credential-free remote is a checked rule.
- **A Charm never runs workspace code.** It runs with the hub's access, so it must not execute anything a hob can write. Push does not run the repository's Git configuration: it uses a Git implementation that runs no hooks and no configured programs, or `git` with hooks disabled (`core.hooksPath` pointed at an empty hub folder) and with repository-set programs ignored (`core.sshCommand`, `core.fsmonitor`, credential helpers, `remote.*.receivepack`, `url.*.insteadOf`, includes). The remote URL and branch are resolved by the hub and shown in the approval.
- Hobbots' coordination tools (delegate, message a hob, report a result) are not Charms. Every hob has them within its policy ([ADR 005](005-agent-parity.md)), and they keep the agent control-plane exclusions of the permissions contract.

**The profile's Tools tab becomes Charms.** The hob profile's tabs are Profile, Charms and Permissions. Charms lists what the hob can do: its runtime's own tools (files, commands, Git, web) with how each is enforced, then its granted Charms with each action's answer. Permissions holds what it may touch: its folders (shared and its own, with add and remove for its own), the sandbox switch and the rules per operation.

### Turning the sandbox off

The sandbox is on by default for every hob, under every preset.

- **Per hob:** the Permissions tab has a "Run in the sandbox" switch. Turning it off is a recorded user grant, offered with a confirmation check box like a high-risk approval, and explains that commands will reach the whole computer. Hobs cannot change it, and delegation cannot pass it on.
- **With Trusting:** picking Trusting shows an extra switch, "Let new hobs run without the sandbox", off by default. When on, new hobs start unsandboxed; existing hobs keep their setting.
- An unsandboxed hob is labeled **Unsandboxed** wherever it appears: profile, chat header, Workbench header and Home tile. Its folder and network rules are then only checked, through the policy hook, and the Permissions tab says so.
- Turning the sandbox back on applies from the next turn.

### What each adapter declares

Each adapter reports, per installed runtime version and platform, these enforcement capabilities, each as verified, unsupported or unverified with evidence ([runtime adapters](../architecture/runtime-adapters.md)):

| Capability | Meaning | When it is missing |
| --- | --- | --- |
| Tool interception | Every tool call reaches Hobbots' policy hook before the runtime approves it on its own, and nothing is loaded from settings on disk | The hob stays chat-only |
| Process sandbox | The runtime starts inside Hobbots' sandbox and works with its own sandbox off | Run commands, Local Git and Use the web are blocked and labeled "Needs the sandbox"; file tools still work through the policy hook |
| Hub tools | Charms and coordination tools can be served over the runtime's control channel | Charms and delegation are unavailable for that hob |
| Tool events | Tool start, finish and denial are reported | Tool steps show only the final reply; tools still run |
| Tool interruption | A running tool can be stopped | Stop ends the reply after the tool returns, and says so |

The sandbox's own availability (the platform, `bubblewrap`, `ripgrep`) is part of Process sandbox. An unverified capability counts as missing until #131 or a later adapter verifies it.

## Rationale

The preset table follows the contract's reference policy and PE-001 directly, and the onboarding rows are the table itself, so what users pick is what the engine enforces. Making Push a Charm turns the riskiest everyday effect into one with exact arguments, an approval and credentials only the hub holds, instead of guessing at shell commands; where a remote needs no credentials, the rule is labeled checked rather than overstated. The policy hook, not `canUseTool`, is the decision point because the SDK approves some calls before the callback runs. Wrapping the whole runtime process in one sandbox gives the same enforced boundary for every runtime, which ADR 002's reuse of several runtimes needs, while each runtime's permission hooks give the per-call decisions and approvals. Calling Delete checked rather than pretending it is enforced keeps the contract's enforcement honesty.

## Consequences for Slice 7

- **#129 Policy engine:** the operations and preset table above, enforced versus checked rules, canonical path comparison including case-insensitive volumes and not-yet-existing paths, per-host network decisions, and the always-blocked addresses.
- **#130 Per-hob folders and overrides:** shared folders plus the hob's own, overrides that only narrow (including hiding a shared folder), and the sandbox switch as a separately recorded user grant.
- **#131 Claude Code tools:** the SDK options above, the runtime started through sandbox-runtime with a per-turn configuration, the protected Git paths, Push as the first Charm running no workspace code, and the enforcement declaration. Verify the policy hook sees reads in the working directory and read-only commands, a write outside the folders fails, a read of a home file outside the folders fails, a `git push` from a command to a remote needing credentials fails, a push to a credential-free remote is labeled checked, an approved Push runs no `pre-push` hook even with `core.hooksPath` set to a writable folder, and record what credential masking hides and whether live configuration updates work.
- **#132 Tool steps:** steps show whether an action was decided by policy or blocked by the sandbox, and label Charms.
- **#133 Ask:** Ask covers file tools, commands, Charms (with exact arguments) and new hosts under Careful; force pushes and pushes to the default branch are once-only.
- **#134 Approval card:** shows the Charm or the host for network requests.
- **#135 Profile tabs:** the tabs become Profile, Charms and Permissions (Tools becomes Charms); folders and the sandbox switch move to Permissions; onboarding's Safety step uses the rows and wording above, plus the Trusting sandbox switch.
- **#136 Unsupported enforcement:** the declaration table above, "Needs the sandbox" on Windows and wherever the sandbox cannot start, and the Unsandboxed label.
- **#137 End to end:** add cases for symlink and `..` escapes, a command writing outside the folders, a `git push` from a command to a remote needing credentials and to a credential-free one, a hostile `core.hooksPath` during an approved Push, and an unsandboxed hob's label.
