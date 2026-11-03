# ADR 024 — The Codex adapter

Status: **Accepted.** Fills the Codex column of the [runtime adapters contract](../architecture/runtime-adapters.md) for Slice 11, applies [ADR 014](014-tool-policy-and-enforcement.md) to Codex, and follows [ADR 002](002-existing-runtimes.md), which chose Codex App Server.

## Context

Slice 11 lets a hob think with Codex beside hobs on Claude Code (RT-001, AG-005). ADR 002 chose the Codex App Server, and ADR 014 said Codex would use its approval hooks inside Hobbots' sandbox with its own sandbox off. Neither was checked against an installed Codex. This ADR records how Hobbots runs Codex and what was verified.

The evidence is a probe of Codex 0.166.0 (`@openai/codex` on npm, released 2026-10-29), run on 2026-11-03 on Linux x86_64. The probe spoke to `codex app-server` over stdio with a small JSON-RPC client. Codex had no account, so a scripted stand-in for the Responses API played the model through a custom model provider. That drove real turns: real commands, file patches, approvals, interrupts and resumed threads, with the model's moves fixed in advance. The protocol came from `codex app-server generate-ts`, which prints the installed version's own types. The [evidence record](../evidence/2026-11-03-codex-app-server-probe.md) lists each check.

What the probe could not reach: macOS, Hobbots' sandbox around Codex, a real ChatGPT sign-in and a real model. Entries that depend on them are marked **unverified**, and the validation section names the issue that checks each one.

## Decision

### Route and version

- **Codex App Server over stdio.** The hub starts `codex app-server` (stdio is its default transport) and speaks JSON-RPC to it, one JSON message per line. The client sends `initialize`, then `initialized`, then works with threads and turns. Codex asks the client questions (approvals, hub tool calls) as JSON-RPC requests on the same channel.
- **One App Server process per turn.** Hobbots' sandbox is generated per turn (ADR 014), so each turn gets its own process inside its own sandbox. The turn resumes the thread's Codex thread, runs one `turn/start` and ends the process once `turn/completed` arrives.
- **The experimental API is turned on.** Hub tools need it (below), so `initialize` declares `capabilities.experimentalApi: true`. Codex labels `app-server` itself experimental, and its protocol changes between releases.
- **Minimum version 0.166.0**, the version probed. An older Codex shows as outdated with how to update it. A newer one runs. The adapter's types come from the probed version's `generate-ts` output, so a protocol change shows up as a failing contract test when the version is raised on purpose.

### Finding Codex and its sign-in

- **The binary.** The hub looks for `codex` the same way it looks for Claude Code: the user's login shell `PATH`, then the usual install folders (Homebrew, `/usr/local/bin`, the npm global prefix). `codex --version` prints `codex-cli 0.166.0`.
- **Sign-in status without credentials.** The hub starts an App Server outside the sandbox with the user's own `CODEX_HOME` and calls `account/read` with `refreshToken: false`. It answers with the account type (`chatgpt`, `apiKey` and others), the email and the plan, or `account: null` when signed out. It never returns a token. Hobbots never opens `auth.json` or the keychain item itself. Verified signed out; signed in is **unverified**.
- **Only a ChatGPT sign-in runs hobs.** As with Claude Code (ADR 009), an API key is never passed to a hob. An API-key login shows as needing a ChatGPT sign-in.
- **Models and efforts.** `model/list` returns each model's ID, display name, description, whether it is hidden, its supported efforts with a description each, its default effort and its input types. Codex 0.166.0 answered it while signed out, from its built-in catalog. The brain picker shows models that are not hidden and the efforts each model lists. Effort `ultra` ("automatic task delegation") starts Codex's own sub-agents, which Hobbots turns off (below), so it is not offered.

### Signing a turn in

The turn's App Server gets the sign-in through the protocol, never through a file or an environment variable:

1. Before a turn, the hub's own App Server (outside the sandbox, the user's `CODEX_HOME`) is asked for a fresh access token with `getAuthStatus` (`includeToken: true`, `refreshToken: true`). Codex refreshes its own login there, so the refresh token stays outside the sandbox.
2. The turn's App Server gets it with `account/login/start` of type `chatgptAuthTokens` (access token and workspace ID). This is Codex's external sign-in mode: Codex keeps the token in memory and writes no `auth.json`.
3. When the token expires mid-turn, Codex sends `account/chatgptAuthTokens/refresh`, and the hub answers with a fresh token from step 1.

Commands never see the token, because it is not in the environment. Steps 1 to 3 are **unverified**: they need a real sign-in, and where the workspace ID comes from is checked in #437.

### Sessions

- **A Codex thread per Hobbots thread.** `thread/start` returns the thread's ID, which Hobbots stores as the thread's runtime session, like Claude Code's. Codex writes the thread to `CODEX_HOME/sessions`.
- **Each hob gets its own `CODEX_HOME`**, beside its Claude Code folder (`<data folder>-runtimes/<hob>/codex`), for the same reasons as ADR 014: the user's own `~/.codex` stays closed, and so do other hobs' threads. It must not be under `/tmp`, where Codex refuses to set up its helper programs.
- **Resume.** A later turn starts a new process and calls `thread/resume` with the thread's ID. Verified: a thread resumed in a new process kept its three earlier turns, and the next model request carried them.
- **Changed instructions.** Like Claude Code, a resumed thread keeps the instructions it started with. Verified: `developerInstructions` passed to `thread/resume` were ignored, and the next request still carried the first ones. So, as for Claude Code, when a hob's instructions change after its thread started, the adapter carries the new ones inside the next turn's input.
- **Cancel and its acknowledgement.** `turn/interrupt` (thread and turn ID) answers `{}` at once. That is not the acknowledgement: the turn is stopped when `turn/completed` arrives with status `interrupted`. Verified: it came about 0.3 seconds after the request, and the running command (`sleep 20; touch late`) was killed, so `late` never appeared. An interrupt while an approval waits resolves the approval (`serverRequest/resolved`), and an answer sent afterwards runs nothing. A process that exits before `turn/completed` ends the turn as uncertain, never as done.
- **Brain switching** works as ADR 017 says: a thread keeps one session per runtime. Its first turn on Codex starts a Codex thread, and switching back to Codex later resumes that same Codex thread, with a briefing for the replies it missed. Switching from Codex to Claude Code and back leaves Claude Code's session alone in the same way.

### Enforcement capabilities

Codex starts each turn with `approvalPolicy: "untrusted"`, `sandbox: "danger-full-access"` on the thread and `sandboxPolicy: { type: "externalSandbox", networkAccess: "enabled" }` on the turn. External sandbox tells Codex that something else confines it, so it runs commands without its own sandbox and leaves the network to Hobbots' proxy.

| Capability | How Codex provides it | Status |
| --- | --- | --- |
| Tool interception | Under `untrusted`, with no execution rules loaded (below), Codex asks the client before **every** command (`item/commandExecution/requestApproval`), even `ls`, `pwd` and `git status`; before every file change (`item/fileChange/requestApproval`); and before every MCP tool call (`mcpServer/elicitation/request`, marked `codex_approval_kind: "mcp_tool_call"`). Hub tools reach the hub as calls it runs itself (below). The hub decides each request with the policy engine. Allow: record `ToolStarted` with `recordToolStart`, then answer `accept`; a failed record answers `decline`. Ask: `ToolAwaitingApproval`, wait for the user, then decide again. Never: `decline`. A command is decided on the script inside Codex's shell wrapper (`/bin/bash -lc '<script>'`), a file change on every path its `item/started` names (the request itself names none), with the files it deletes decided as a deletion, and a request to type into a running command (`kind: "writeStdin"`) is declined. MCP calls are declined, since the hob's Codex loads no MCP servers. | Verified on Linux with a stand-in model ([evidence](../evidence/2026-11-03-codex-tool-policy.md)) |
| Process sandbox | Hobbots wraps `codex app-server` in sandbox-runtime, as ADR 014 says, with Codex's own sandbox off (external sandbox above). The turn starts in the hob's first folder. | Verified on macOS with a stand-in model (`[TC-RT-068]`, `[TC-RT-071]`); on Linux Codex starts inside it, and a whole turn inside it is **unverified** |
| Hub tools | Codex's dynamic tools (below), not MCP. | Verified with a stand-in model, and with the hub in CI (#440) |
| Tool events | `item/started` and `item/completed` carry each command (line, folder, status, exit code, output), file change, MCP call and hub tool call. `item/commandExecution/outputDelta` streams output while a command runs, so Codex reports `ToolOutput`, unlike Claude Code. A declined command ends with status `declined`. | Verified with a stand-in model |
| Tool interruption | `turn/interrupt`, acknowledged by `turn/completed` with status `interrupted` (above). | Verified with a stand-in model |

**Which calls Codex runs without asking.** Under `untrusted` with an external sandbox and no execution rules, Codex 0.166.0 asked about every command and file change in the probe. It did not ask about:

- `view_image`, which read an image outside the thread's folder without asking. Hobbots turns it off (`features.view_image = false`), since it reads files with no call to decide or record. Reads stay possible through commands, which are decided.
- Codex's own sub-agents (`collaboration.spawn_agent` and the rest), which run work Hobbots would not see as delegation. Turned off (`features.multi_agent = false`).
- Tools that reach beyond the folders without a decision: web search, image generation, apps, plugins, the browser, computer use and memories. Turned off in the hob's Codex configuration.
- Code mode's `exec`, the JavaScript tool that calls the others. It runs in an isolate with no files, network or console, and each tool it calls is still asked about. It stays.

That these features are off is checked in #439 from the tools the first model request offers. A tool Codex adds in a later version is offered to the model only if the hob's configuration allows it, so the adapter lists the tools it allows and the contract test fails on any other.

**Codex's own hooks are not used.** Codex 0.166.0 has `PreToolUse` and `PermissionRequest` hooks, and the probe showed a `PreToolUse` hook sees shell commands (as `Bash`), `apply_patch` and hub tools, and can refuse one with a reason. But a hook is a command Codex runs, so it would run inside the sandbox and need a way to reach the hub. Approval requests already reach the hub on the channel it holds. The cost: a call the policy refuses reaches the model as "rejected by user", not with the policy's reason. The Workbench and `ToolDenied` keep the reason.

**What is blocked when one is missing.** ADR 014's table applies unchanged. Where the sandbox around Codex is not verified, Linux today, a Codex hob gets file changes through approvals only: commands, Local Git and the web are blocked and labeled, and Codex is not offered its shell (`features.shell_tool = false`). Hub tools need none of the missing capabilities, so a Codex hob delegates, reports and uses Charms.

### What Codex reads from the folders and its home

Codex also runs commands without asking when an **execution rule** allows them. Rules are `*.rules` files in `CODEX_HOME/rules` and in a folder's `.codex/rules`, loaded each time an App Server starts. Verified: a `prefix_rule(pattern=["touch"], decision="allow")` in either place made `touch b.txt` run with no approval request, so the hub neither decided nor recorded it. A hob can write files in its folders, and Codex writes in its home, so without the rules below a command allowed once could write a rule that lets later turns skip the policy. The App Server has no switch to ignore rules (only `codex exec` has `--ignore-rules`), so Hobbots closes both places:

- **Folders are marked untrusted.** Before each turn, the hub writes `trust_level = "untrusted"` into the hob's `CODEX_HOME/config.toml` for each of the hob's folders and for the Git repository root above each, since Codex looks for project configuration from the repository root down. Codex then loads no project layer from them: no `.codex/rules`, hooks or MCP servers. Verified: with the folder marked untrusted, the same rule was ignored and `touch b.txt` asked. `AGENTS.md` in a folder is still read as instructions, like a person's own Codex would.
- **`CODEX_HOME` is read-only to the sandbox, except what Codex must write.** The sandbox may write only `sessions/`, `shell_snapshots/`, `thread-writer-locks/`, `.tmp/`, `tmp/` (where Codex sets up its helper programs on Linux), `installation_id` (which Codex opens for writing at every start, even when it exists) and a separate state folder that holds Codex's databases and logs (`sqlite_home` and `log_dir`). Everything else is read-only: `config.toml`, which holds the folders' trust, the trusted hooks, the MCP servers and the model providers; `rules/`, which the hub creates empty; `skills/`; and any `AGENTS.md`. Verified with `sqlite_home` and `log_dir` moved: Codex wrote only those folders, `installation_id`, `.sandbox_migration` and its bundled skills in `skills/.system`. The hub starts Codex once outside the sandbox before the hob's first sandboxed turn so these exist. Verified at start on Linux: Codex 0.166.0 started inside bubblewrap with the rest closed. On Linux sandbox-runtime mounts a folder opened for reading after the writable folders inside it, which hides them, so the sandbox opens what Codex reads in its home one entry at a time instead of the whole folder.
- **A rule the hub never writes.** The hub never answers an approval with `acceptWithExecpolicyAmendment`, so Codex never adds a rule on the user's behalf. A standing grant stays in Hobbots (ADR 015).
- **Only named variables reach Codex.** Codex passes its whole environment to the commands it runs. Verified: a variable named `MY_TOKEN` reached a command. So ADR 014's allowlist of variables applies to the App Server process as it does to Claude Code, without Claude Code's own variables and sign-in, and Codex's sign-in travels in the protocol instead (above).

### Hub tools

The turn's coordination tools and Charm actions are Codex **dynamic tools**: `thread/start` declares them (name, description, input schema), and Codex sends each call to the client as `item/tool/call`, which the hub runs and answers with `contentItems` and `success`. Verified: a declared tool was offered to the model and its call reached the client.

The tools reach the hub on the channel the hub already holds, so the sandboxed process needs no hub address and no token. An MCP server would be a process Codex starts inside the sandbox, which would need both. Dynamic tools need the experimental API, which is the cost. Each call is decided by the hub, never approved by name, shows as a step, and carries its step for approvals, as in ADR 014 for Claude Code.

How a call runs (#440):

- **The turn starts once the hub has the session.** `turn/start` is sent only after the hub has taken `SessionStarted`, when it accepts the work the turn carries, so no hub call reaches it first. Found when a `complete_task` on PostgreSQL ran before that acceptance and the turn was stopped as stale.
- **A step from the moment Codex asks.** The step's ID is the call's `callId`, which is also the ID of Codex's `dynamicToolCall` item. The hub is given that step, so a call that needs the user's approval waits on it.
- **It ends with Codex's record of it.** The step ends when `item/completed` arrives for the call, as failed when the hub refused it (`success: false`). A Codex that exits before it recorded the answer leaves the call uncertain (EX-004): the hub may have done the work, but the hob never heard the answer.
- **The hub finishes what it started.** A Codex that exits, or a turn that is cancelled, stops waiting for the answer, but the hub call runs to its end, as on Claude Code, so a write is never cut off halfway.
- **A thread keeps the tools it started with.** Verified on Codex 0.166.0: `thread/resume` takes no dynamic tools and ignores any it is given, so a resumed thread offers its first turn's tools. The hub decides every call against the turn's own tools, so a tool the thread was offered but the turn does not hold is refused, and a turn with no hub tools refuses every call. A tool the hob gains after its Codex thread started, such as a Charm granted later, is not offered in that thread; a new thread offers it.

### Commit identity and attribution

- **Identity.** Codex passes `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n` and `GIT_CONFIG_VALUE_n` to its commands unchanged (verified). So ADR 014's signing switch and ADR 022's bot identity work for Codex hobs through the same variables.
- **No attribution.** Codex 0.166.0 contains a `<git_attribution>` instruction asking the model to end commit messages with `Co-authored-by: Codex <noreply@openai.com>`. It did not appear in the probe, with a custom provider and no account; it seems tied to a ChatGPT account setting, and `commit_attribution` is not a configuration key in 0.166.0 (Codex reports it as unrecognized). So the adapter adds a rule to every Codex turn's instructions: add no Codex attribution to commits or pull requests. Whether Codex still asks for the trailer once signed in, and whether it can be turned off, is **unverified** and needs a real sign-in ([#442](https://github.com/otaviobarros/hobbots/issues/442)).

### Usage

`thread/tokenUsage/updated` arrives during each turn with the last request's and the thread's totals: input, cached input, output and reasoning tokens, and the model's context window. Verified with a stand-in model. Usage is recorded per reply, to the brain that ran it (ADR 017). `account/rateLimits/updated` reports the plan's limits for provider health; its contents are **unverified**. Codex reports no cost.

## Consequences

- Codex hobs get the same policy, records and Workbench as Claude Code hobs. They also stream command output, which Claude Code does not.
- The adapter depends on Codex's experimental API (`app-server`, dynamic tools), so raising the Codex version is a deliberate change with the contract test.
- A policy refusal reaches a Codex model as a plain rejection.
- Codex hobs cannot use Codex's own sub-agents, web search or images; delegation goes through Hobbots.
- A Codex thread offers the hub tools it started with. A Charm granted after a Codex thread started reaches the hob in a new thread only.

## Validation

The scenarios that would show this decision holds. Each names the issue that will prove it.

- Settings › Providers shows a ready Codex and each unavailable state (not installed, older than 0.166.0, signed out, signed in with an API key only) with its fix, reading sign-in status through `account/read` without opening `auth.json` or the keychain; and the hub lists Codex's models and their efforts, without `ultra`, offering them to the brain picker now that Codex turns run (`[TC-RT-034]`, `[TC-RT-035]`, `[TC-RT-036]`). Proven with a stand-in Codex and checked against Codex 0.166.0 signed out; a signed-in Codex is not verified: [#437](https://github.com/otaviobarros/hobbots/issues/437), [evidence](../evidence/2026-11-03-codex-detection.md).
- A turn signs in with a short-lived access token through `chatgptAuthTokens`, a refresh request mid-turn is answered, and no token reaches a command's environment or a file in the sandbox. Not proven yet: [#437](https://github.com/otaviobarros/hobbots/issues/437) and [#442](https://github.com/otaviobarros/hobbots/issues/442).
- A Codex hob answers, is stopped mid-turn with `turn/completed` status `interrupted` as the acknowledgement, resumes its thread in a later turn, receives changed instructions inside the turn, and ends a turn whose process died as uncertain: `[TC-RT-020]` to `[TC-RT-028]` and `[TC-RT-033]` with a scripted App Server, and on an installed Codex 0.166.0 with a stand-in model on Linux: `[TC-RT-029]`, `[TC-RT-030]`, `[TC-RT-031]` ([evidence](../evidence/2026-11-03-codex-turns.md)). With a real model and sign-in, on macOS, not proven yet: [#442](https://github.com/otaviobarros/hobbots/issues/442).
- A command allowed in one turn writes an allow rule into `CODEX_HOME/rules` and into a folder's `.codex/rules`; the write to `CODEX_HOME/rules` fails, and in the next turn a command the rule names still asks the hub and is recorded before it runs: `[TC-RT-068]`, on macOS with a stand-in model ([evidence](../evidence/2026-11-03-codex-tool-policy.md)). On Linux, not proven yet: [#442](https://github.com/otaviobarros/hobbots/issues/442).
- Every command and file change Codex asks about is decided by the policy, recorded before it runs, refused when the record fails, held under Ask and declined under Never, and reported to the Workbench with its streamed output: `[TC-RT-061]` to `[TC-RT-067]` and `[TC-RT-070]` in CI, and on an installed Codex 0.166.0 with a stand-in model, `[TC-RT-069]` ([evidence](../evidence/2026-11-03-codex-tool-policy.md)). The first model request offers no `view_image`, sub-agent or web search tool (`[TC-RT-029]`). A whole turn runs inside Hobbots' sandbox on macOS with Codex's own sandbox off, and offers no `view_image`, web search, image generation or sub-agent tool (`[TC-RT-068]`); on Linux Codex starts inside it. The app, plugin, browser and computer tools with a real sign-in: [#442](https://github.com/otaviobarros/hobbots/issues/442).
- A Codex hob's commits carry the hob's identity, honor the signing switch and carry no Codex attribution once signed in. The identity and signing variables reach Codex through the same sandbox wrap as Claude Code's; no attribution once signed in needs a real sign-in. Not proven yet: [#442](https://github.com/otaviobarros/hobbots/issues/442).
- A Codex hob delegates and uses Charms through dynamic tools decided by the hub, each call a step that carries its step for approvals, with no hub address or token in the sandbox; a call whose answer Codex never recorded is uncertain; a resumed thread keeps the tools it started with and the hub refuses one the turn does not hold; and a Claude hob delegates to a Codex hob, and a Codex hob to a Claude hob, each getting the result: `[TC-RT-080]` to `[TC-RT-082]` and `[TC-RT-086]` with a scripted App Server, `[TC-RT-083]` on an installed Codex 0.166.0 with a stand-in model, and `[TC-RT-084]`, `[TC-RT-085]` with the hub and a stand-in Codex in CI ([#440](https://github.com/otaviobarros/hobbots/issues/440), [evidence](../evidence/2026-11-03-codex-hub-tools.md)). With a real model on macOS, not proven yet: [#442](https://github.com/otaviobarros/hobbots/issues/442).
- Codex shows as a provider in onboarding, Summon and the profile, either Claude Code or Codex is enough to finish onboarding, and a missing, signed-out or outdated Codex shows as unavailable with its fix and cannot be picked: `[TC-UX-080]` to `[TC-UX-083]`, in Chromium against the real Codex adapter with a stand-in Codex, and the fake runtime for the profile. On macOS with an installed Codex, not proven yet: [#442](https://github.com/otaviobarros/hobbots/issues/442).
- A Claude hob delegates to a Codex hob in one Quest and gets its result, with the fake runtime in CI on SQLite and PostgreSQL and once by hand with an installed Codex on macOS. Not proven yet: [#442](https://github.com/otaviobarros/hobbots/issues/442).
- The App Server behaviors this ADR relies on were observed on Codex 0.166.0 with a stand-in model: [evidence](../evidence/2026-11-03-codex-app-server-probe.md).
