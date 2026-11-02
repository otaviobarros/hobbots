# Runtime adapters

**Decided:** reuse existing runtimes, starting with Claude Code and Codex, with an ACP-compatible adapter foundation. Hobbots owns orchestration, durable responsibilities and UI; it does not recreate the runtime's reasoning/tool loop.

## Integration targets

| Target | Planned route | Status in this foundation |
|---|---|---|
| Codex | Codex App Server adapter | Selected; installed-version contracts and enforcement need live verification. |
| Claude Code | Supported CLI/SDK integration | Selected; exact route/version needs compatibility validation. |
| ACP agents | ACP client adapter with capability negotiation | Foundation selected; per-agent interoperability is not yet demonstrated. |
| Other CLIs/local-model runtimes | Individually validated future adapters | Outside initial support guarantees. |

ACP describes client/agent interactions; it does not supply Hobbots' multi-agent delegation, responsibility ledger or durable inbox. MCP exposes scoped tools; it is not interchangeable with ACP.

## Common internal contract (draft names)

`detect`, `listModels`, `createSession`, `resumeSession`, `sendPrompt`, `subscribeEvents`, `respondToApproval`, `cancel`, `getCapabilities`, `close`. These are Hobbots interface concepts, not claims that vendor APIs expose identical methods. Detect installation/version/authentication availability without reading or logging credentials.

Normalize text/tool/status/approval/result events into Hobbots envelopes while retaining useful runtime provenance. Tool calls become `ToolStarted` (id, the runtime's tool name, the policy operation, its targets and a short label), `ToolFinished` (whether the tool failed), `ToolAwaitingApproval` (the call waits for the user's decision on an approval request) and `ToolDenied` (the reason, and who refused it: the policy, the user or the sandbox). A call the policy answers Ask for is asked through the turn's approvals and decided again under the current policy before it runs. Today only the policy, or the user through it, refuses a call before it runs; a command the sandbox stops ends as a failed `ToolFinished`. A call the policy allows is recorded durably before it runs: the adapter hands its `ToolStarted` to the turn's `recordToolStart` and waits, and refuses the call if Hobbots could not record it, so no call ever runs without a record (EX-004). Record terminal outcome and uncertainty. Effect scopes own process/connection cleanup; closing one client must not kill unrelated work.

## Capability matrix to fill with evidence

For each runtime/version/executor, verify native session persistence/resumption versus reconstruction; concurrent sessions versus serialized turns; streaming and cursor semantics; interruption acknowledgement; approval interception; sandbox/filesystem/network restrictions; terminal/artifact/diff visibility; browser screenshots versus live browser control; computer opt-in; model discovery; usage reporting; MCP support and scoped credentials.

Each adapter also declares its enforcement capabilities (tool interception, process sandbox, hub tools, tool events, tool interruption) and what is blocked without each; [ADR 014](../decisions/014-tool-policy-and-enforcement.md) owns that table. The declaration travels with provider health and the hob's permissions, so Settings and the hob profile show it, and the profile blocks rather than shows as safe what an unsupported capability leaves unheld (PE-005). A process sandbox that is unsupported or not yet verified on this hub counts as missing, as ADR 014 requires: commands, local Git and the web are blocked, and the profile says which applies and why. An unverified sandbox that starts still wraps the runtime for file tools. Hobbots wraps the whole runtime process in its own sandbox and turns the runtime's sandbox off inside it, so a runtime's native sandbox modes are not part of the contract.

Classify each capability as verified supported, unsupported, conditional or unverified, with runtime version, test date and evidence. The Claude Code adapter's enforcement capabilities were verified on macOS in October 2026 (Claude Code 2.1.301, sandbox-runtime 0.0.81): tool interception, the process sandbox, tool events and tool interruption; hub tools are unsupported until Charms land. The adapter can already serve a turn's coordination tools as an in-process MCP server on Claude Code's control channel, approved by its own hook rather than by name in `allowedTools`, so the permission callback stays unshadowed, and decided by the hub rather than the policy hook, and each call shows as a step. Chat turns and steps offer them ([#272](https://github.com/otaviobarros/hobbots/issues/272)), and chat turns also offer the GitHub Charm's read actions ([#317](https://github.com/otaviobarros/hobbots/issues/317)) and its push ([#323](https://github.com/otaviobarros/hobbots/issues/323)). A hub tool call carries the step Claude Code announced it as in the PreToolUse hook, so a Charm can ask for approval on that step and mark it uncertain (`ToolUncertain`) when a write's answer is lost; this has not been verified with an installed Claude Code. The evidence is in ADR 014. Every other live capability entry is still **unverified**. The selected integration strategy is not proof that a runtime supports every product feature.

Evidence so far: a resumed Claude Code session (2.1.301) keeps the system prompt it started with and ignores the one passed with a new turn, including `--append-system-prompt`, a full `--system-prompt` and `--fork-session`. So when a hob's instructions change after a thread's session started, the adapter carries the new instructions inside the next turn instead of the system prompt, which keeps the session's context.

Expose unsupported previews and unavailable safe policies honestly. A text URL is not a live browser. A process exit is not necessarily a closed Quest. Cancellation acknowledgement and session resume must be checked rather than inferred.

## Verification strategy

Build a deterministic fake adapter when implementation is authorized. Exercise nested delegation, delayed results, busy recipients, permission denial, crashes, unknown side-effect outcomes and late events without model/API costs. Then test minimal real Codex/Claude sessions and selected ACP peers. Record runtime versions and evidence before claiming cross-runtime support.

Versioned capability contracts isolate protocol differences from domain services. Vendor-specific session identifiers, errors or permission modes must not become the canonical Agent or Quest model.
