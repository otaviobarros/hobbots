# Runtime adapters

**Decided:** reuse existing runtimes, starting with Claude Code and Codex, with an ACP-compatible adapter foundation. Hobbots owns orchestration, durable responsibilities and UI; it does not recreate the runtime's reasoning/tool loop.

## Integration targets

| Target | Planned route | Status in this foundation |
|---|---|---|
| Codex | Codex App Server over stdio, 0.166.0 or later ([ADR 024](../decisions/024-codex-adapter.md)) | Selected; App Server behavior, the policy on its tool calls and a whole turn in the sandbox on macOS verified with a stand-in model; the sandbox on Linux and a real sign-in still need verification. |
| Claude Code | Supported CLI/SDK integration | Selected; exact route/version needs compatibility validation. |
| ACP agents | ACP client adapter with capability negotiation | Foundation selected; per-agent interoperability is not yet demonstrated. |
| Other CLIs/local-model runtimes | Individually validated future adapters | Outside initial support guarantees. |

ACP describes client/agent interactions; it does not supply Hobbots' multi-agent delegation, responsibility ledger or durable inbox. MCP exposes scoped tools; it is not interchangeable with ACP.

## Common internal contract (draft names)

`detect`, `listModels`, `createSession`, `resumeSession`, `sendPrompt`, `subscribeEvents`, `respondToApproval`, `cancel`, `getCapabilities`, `close`. These are Hobbots interface concepts, not claims that vendor APIs expose identical methods. Detect installation/version/authentication availability without reading or logging credentials.

Normalize text/tool/status/approval/result events into Hobbots envelopes while retaining useful runtime provenance. Tool calls become `ToolStarted` (id, the runtime's tool name, the policy operation, its targets and a short label), `ToolFinished` (whether the tool failed), `ToolAwaitingApproval` (the call waits for the user's decision on an approval request) and `ToolDenied` (the reason, and who refused it: the policy, the user or the sandbox). A call the policy answers Ask for is asked through the turn's approvals and decided again under the current policy before it runs. Today only the policy, or the user through it, refuses a call before it runs; a command the sandbox stops ends as a failed `ToolFinished`. A call the policy allows is recorded durably before it runs: the adapter hands its `ToolStarted` to the turn's `recordToolStart` and waits, and refuses the call if Hobbots could not record it, so no call ever runs without a record (EX-004). A command's `ToolStarted` also carries its line, the folder it runs in and whether it runs in the sandbox, and its `ToolFinished` its exit code when the runtime reports one; a runtime that streams output reports it as `ToolOutput` while the command runs. Claude Code reports output only when a command ends. The hub records these for the Workbench the same way for every runtime ([ADR 023](../decisions/023-workbench.md)). A turn that finishes ends with `Completed`, which carries what the turn took and used when the runtime reports it: milliseconds until the runtime sent its first model request, until the response stream opened and until the first complete message, and its input, output, cache-read and cache-write tokens. Any field can be null for a runtime that does not report it. The hub keeps them on the reply next to the runtime and model its turn ran on ([#398](https://github.com/otaviobarros/hobbots/issues/398)). Claude Code's figures come from its result message and count the main session only, without subagents. A turn that fails records none yet. Record terminal outcome and uncertainty. Effect scopes own process/connection cleanup; closing one client must not kill unrelated work.

## Capability matrix to fill with evidence

For each runtime/version/executor, verify native session persistence/resumption versus reconstruction; concurrent sessions versus serialized turns; streaming and cursor semantics; interruption acknowledgement; approval interception; sandbox/filesystem/network restrictions; terminal/artifact/diff visibility; browser screenshots versus live browser control; computer opt-in; model discovery; usage reporting; MCP support and scoped credentials.

Each adapter also declares its enforcement capabilities (tool interception, process sandbox, hub tools, tool events, tool interruption) and what is blocked without each; [ADR 014](../decisions/014-tool-policy-and-enforcement.md) owns that table. The declaration travels with provider health and the hob's permissions, so Settings and the hob profile show it, and the profile blocks rather than shows as safe what an unsupported capability leaves unheld (PE-005). A process sandbox that is unsupported or not yet verified on this hub counts as missing, as ADR 014 requires: commands, local Git and the web are blocked, and the profile says which applies and why. An unverified sandbox that starts still wraps the runtime for file tools. Hobbots wraps the whole runtime process in its own sandbox and turns the runtime's sandbox off inside it, so a runtime's native sandbox modes are not part of the contract.

An adapter may also report its plan's meters for the Usage screen (`planUsage`, OP-002), as the provider sends them and without spending any of them; without it, the plan shows as not reported. Claude Code's come from its `/usage` report, a local command that makes no model request, read at most once a minute. Claude Code 2.1.316 was seen answering `/usage` in about a second with no model request and, signed in without a claude.ai plan, with no meters; a claude.ai plan's meters are unverified.

Classify each capability as verified supported, unsupported, conditional or unverified, with runtime version, test date and evidence. The Claude Code adapter's enforcement capabilities were verified on macOS in October 2026 (Claude Code 2.1.301, sandbox-runtime 0.0.81): tool interception, the process sandbox, tool events and tool interruption; hub tools are unsupported until Charms land. The adapter can already serve a turn's coordination tools as an in-process MCP server on Claude Code's control channel, approved by its own hook rather than by name in `allowedTools`, so the permission callback stays unshadowed, and decided by the hub rather than the policy hook, and each call shows as a step. Chat turns and steps offer them ([#272](https://github.com/otaviobarros/hobbots/issues/272)), and chat turns also offer the GitHub Charm's read actions ([#317](https://github.com/otaviobarros/hobbots/issues/317)) and its push ([#323](https://github.com/otaviobarros/hobbots/issues/323)). A hub tool call carries the step Claude Code announced it as in the PreToolUse hook, so a Charm can ask for approval on that step and mark it uncertain (`ToolUncertain`) when a write's answer is lost; this has not been verified with an installed Claude Code. The evidence is in ADR 014. Every other live Claude Code capability entry is still **unverified**. The Codex column above says which Codex entries are verified. The selected integration strategy is not proof that a runtime supports every product feature.

## Codex column

Codex 0.166.0, probed on 2026-11-03 on Linux with a stand-in model ([ADR 024](../decisions/024-codex-adapter.md), [evidence](../evidence/2026-11-03-codex-app-server-probe.md)).

| Capability | Codex | Status |
|---|---|---|
| Detection | `codex --version`; sign-in through `account/read`, which returns no token | Verified signed out; signed in unverified |
| Models and efforts | `model/list`: models, supported efforts, default effort | Verified |
| Sessions | One Codex thread per Hobbots thread, in the hob's own `CODEX_HOME`; `thread/resume` in a new process | Verified |
| Changed instructions | Ignored on resume, so carried inside the next turn | Verified |
| Concurrency | One App Server process per turn; two turns of one hob at once | Unverified |
| Streaming | Item notifications and text deltas; command output streams (`ToolOutput`) | Verified |
| Interruption | `turn/interrupt`, acknowledged by `turn/completed` with status `interrupted` | Verified |
| Tool interception | Approval requests for every command, file change and MCP call under `untrusted`, decided by the policy and recorded before they run, with execution rules closed off (folders untrusted, `CODEX_HOME` read-only but for what Codex writes) | Verified ([evidence](../evidence/2026-11-03-codex-tool-policy.md)); the read-only home checked at start only |
| Process sandbox | Hobbots' sandbox around the App Server; Codex's own off (`externalSandbox`) | Verified on macOS; Codex starts inside it on Linux, a whole turn there unverified |
| Hub tools | Dynamic tools, called back on the App Server channel | Verified |
| Tool events | `item/started`, `item/completed`, output deltas, reported to the Workbench as Claude Code's are | Verified |
| Usage | `thread/tokenUsage/updated` per turn; no cost | Verified; rate limits unverified |
| Sign-in for a turn | `chatgptAuthTokens` with refresh requests answered by the hub | Unverified |
| Commit attribution | Hob instructions; Codex's own trailer request when signed in | Unverified |

Evidence so far: a resumed Claude Code session (2.1.301) keeps the system prompt it started with and ignores the one passed with a new turn, including `--append-system-prompt`, a full `--system-prompt` and `--fork-session`. So when a hob's instructions change after a thread's session started, the adapter carries the new instructions inside the next turn instead of the system prompt, which keeps the session's context.

Expose unsupported previews and unavailable safe policies honestly. A text URL is not a live browser. A process exit is not necessarily a closed Quest. Cancellation acknowledgement and session resume must be checked rather than inferred.

## Verification strategy

Build a deterministic fake adapter when implementation is authorized. Exercise nested delegation, delayed results, busy recipients, permission denial, crashes, unknown side-effect outcomes and late events without model/API costs. Then test minimal real Codex/Claude sessions and selected ACP peers. Record runtime versions and evidence before claiming cross-runtime support.

Versioned capability contracts isolate protocol differences from domain services. Vendor-specific session identifiers, errors or permission modes must not become the canonical Agent or Quest model.
