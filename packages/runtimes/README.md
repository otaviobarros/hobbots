# packages/runtimes

Validation slice implemented ([ADR 009](../../docs/decisions/009-toolchain-and-validation-slice.md)): Runtime adapter interface, the Claude Code adapter (Agent SDK) and a deterministic fake adapter.

Codex, Claude Code and ACP adapters, versioned capability discovery and normalization.

Tools follow [ADR 014](../../docs/decisions/014-tool-policy-and-enforcement.md):

- `tool-calls.ts` turns Claude Code's tool calls into policy requests, from the call's own arguments.
- `claude-code.ts` puts every call before the policy engine through a `PreToolUse` hook, works in the hob's folders and reports tool events. A turn without folders stays chat-only.
- `sandbox.ts` starts the runtime inside sandbox-runtime, once per hub, with each turn's folders and hosts. The keychain stays closed inside it; the runtime gets its sign-in in its environment.
- The fake runtime plays a prompt line `fake:tool <Tool> <path or command>` as a tool call decided by the policy engine, so tests need no model.

Read the [architecture overview](../../docs/architecture/overview.md) and relevant specifications before implementation. Credentials are never stored here.
