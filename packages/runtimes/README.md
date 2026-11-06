# packages/runtimes

Validation slice implemented ([ADR 009](../../docs/decisions/009-toolchain-and-validation-slice.md)): the Claude Code adapter (Agent SDK) and a deterministic fake adapter. Both implement the `RuntimeAdapter` port that `@hobbots/agents` defines.

Codex, Claude Code and ACP adapters, versioned capability discovery and normalization.

Tools follow [ADR 014](../../docs/decisions/014-tool-policy-and-enforcement.md):

- `tool-calls.ts` turns Claude Code's tool calls into policy requests, from the call's own arguments.
- `claude-code.ts` puts every call before the policy engine through a `PreToolUse` hook, works in the hob's folders and reports tool events. A turn without folders stays chat-only.
- `sandbox.ts` starts the runtime inside sandbox-runtime, once per hub, with each turn's folders and hosts. The keychain, the user's own Claude Code folder and other data folders stay closed inside it; the runtime gets its sign-in in its environment, a configuration folder of its own per hob, and only named environment variables.
- `codex/turn.ts` runs a Codex turn on its own App Server process ([ADR 024](../../docs/decisions/024-codex-adapter.md)): it starts or resumes the thread's Codex thread, signs it in through the protocol, cancels with `turn/interrupt` and waits for Codex to acknowledge it, and ends a turn whose process died as uncertain. `codex/events.ts` turns Codex's notifications into runtime events. `codex/policy.ts` decides each command and file change Codex asks about with the hob's policy and records it before it runs; a turn with tools starts Codex inside the sandbox, and a turn without them refuses every call. `test/codex-live.test.ts` runs turns on an installed Codex with a stand-in model when `HOBBOTS_CODEX` names its binary.
- `skills.ts` writes a turn's skills into a read-only folder of their own ([ADR 029](../../docs/decisions/029-skills.md)); `claude-code-skills.ts` loads it as a skills-only plugin, and `codex/skills.ts` hands it to Codex as its only extra root, turns off every other skill and checks `skills/list` before the turn. `test/clean-runtime-*.test.ts` check that each runtime loads nothing from its own setup; the Claude Code one runs when `HOBBOTS_CLAUDE_CODE` names a `claude` binary.
- The fake runtime plays a prompt line `fake:tool <Tool> <path or command>` as a tool call decided by the policy engine, so tests need no model.

Read the [architecture overview](../../docs/architecture/overview.md) and relevant specifications before implementation. Credentials are never stored here.
