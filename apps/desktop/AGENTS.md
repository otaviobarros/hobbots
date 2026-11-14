# Desktop app

The desktop app is the Electron shell around the hub. These rules add to the root [AGENTS.md](../../AGENTS.md).

## Code Review Rules

- Read the [desktop standards](../../docs/standards/desktop.md) and the [security standards](../../docs/standards/security.md). A breach that lets a renderer, a page or a link reach the main process, the file system or a credential is P0.
- Renderers stay isolated and sandboxed (STD-DESKTOP-001). The preload exposes a narrow, typed bridge (STD-DESKTOP-002).
- Every IPC handler is registered through `trusted-ipc.ts`, checks its sender and parses its input with an Effect Schema (STD-DESKTOP-003).
- Navigation, new windows and external links stay limited (STD-DESKTOP-004), and permission requests are denied unless allowed (STD-DESKTOP-005).
- The main process never blocks (STD-DESKTOP-008).
