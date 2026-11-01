# Open questions and bounded assumptions

These choices are not decided yet. They do not reopen decided product direction. Resolve the relevant ones before implementing affected areas, using current documentation and runtime evidence.

| Area | Open choice / required evidence |
|---|---|
| Runtime support | Exact installed Codex/Claude/Gemini CLI/Ollama/ACP versions, integration routes, auth, sandbox/approval hooks, resume/cancel/concurrency/preview capabilities. |
| Effect v4 | Exact compatible pins, SQL drivers and unstable Workflow/HttpApi integration; evaluate native durable Workflow versus persistent execution services behind the domain interfaces. |
| Toolchain | Package manager, workspace/build/test tooling, supported Node/Electron versions. Decided for the validation slice in ADR 009. |
| Configuration | Canonical app database versus portable JSON/YAML definitions versus both; import/export/versioning details. |
| Delegation default | Explicit collaborator allowlist versus all configured hobs by default; automatic dynamic agent creation is not assumed. |
| Limits | Final concurrency, timeout, fairness, batching, retry and cost-limit defaults. The depth limit defaults to 2 ([ADR 018](../decisions/018-tasks-and-quests.md)). |
| Remote-to-local routing | Explicit handoff versus configured scoped routes, pairing, execution-grant transport and revocation. No silent privilege expansion. |
| Policies | The preset mapping, folders and the sandbox are decided in ADR 014; what sandbox-runtime's credential masking hides and whether its live configuration updates work need evidence (#131). Grant matching, precedence, expiry and revocation are decided in ADR 015. |
| Lifecycle | Exhaustive task/attempt/approval transition tables, late-result and reassignment rules, partial completion semantics. |
| Deployment | OS/architecture support, app-data paths, per-platform service installation, device token format and storage, routes after Tailscale. |
| Persistence | Artifact storage backend, backup consistency, retention/redaction. Event compaction and cursor expiry are decided in ADR 013. |
| UI extensions | Narrow-window behavior and a screen-reader and keyboard pass in the real app (the design tokens pass WCAG AA); generalized takeover/replay remains later. |
| Providers | How API-key providers (Grok, OpenAI-compatible keys, Gemini without its CLI) run tools and delegation, given [ADR 002](../decisions/002-existing-runtimes.md)'s reuse of existing agent runtimes; what usage data each provider reports for the Usage potions. |
| Home | Exact Home contents beyond the design (what is happening, a summary, usage limits); team grouping for many hobs. |
| Optional suggestions | Thread forking/context snapshots and advanced memory are not MVP decisions. |

These documents are concrete enough for requirements review and scoped engineering plans. They are not proof of live runtime capability, a production threat model, or an installed dependency stack. Avoid silently converting this table into defaults.
