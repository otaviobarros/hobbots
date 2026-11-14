# Runtimes package

The runtimes package holds the adapters that run hobs on existing runtimes: Claude Code, Codex and the fake runtime the tests use. These rules add to the root [AGENTS.md](../../AGENTS.md).

## Code Review Rules

- Runtime parity: a change to how hobs run, resume, stop, use tools, steer or ask for permission covers Claude Code, Codex and the fake runtime, with a test for each, or says why one does not apply (STD-ARCH-009, STD-ARCH-010). A rule held on one runtime and not the other is P1, and P0 when it is a security boundary.
- An adapter reports the capabilities the installed runtime has. A capability assumed from a protocol name or a flag the installed version lacks is a finding (STD-ARCH-009).
- Permissions are enforced by the sandbox, the runtime's own permission mode or the tool policy engine, never by prompt text (STD-SEC-002). Read the [permissions contract](../../docs/architecture/permissions.md) and the [runtime adapters contract](../../docs/architecture/runtime-adapters.md).
- Output from a runtime, a model or a tool is untrusted input. It is parsed before use, and patterns run on it in linear time (STD-SEC-005).
- Credentials never enter the sandbox or a hob's environment, and never reach logs.
- The fake runtime behaves like the real ones for the case under test, so tests built on it stay true (STD-TEST-002).
