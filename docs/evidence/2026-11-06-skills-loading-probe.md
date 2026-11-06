# Where Claude Code and Codex find skills, with fake home folders and stand-in models

- **Date:** 2026-11-06
- **Issue:** [#1058](https://github.com/otaviobarros/hobbots/issues/1058)
- **Pull request:** the pull request that adds [ADR 029](../decisions/029-skills.md)
- **Commit:** `8fc9720` on `main`, for the probe; no Hobbots code ran
- **Setup:** Manual probe in a Linux x86_64 container (Node 22). Codex 0.166.0 (`@openai/codex` from npm, `codex-cli 0.166.0`), started as `codex app-server` over stdio by a small JSON-RPC client, with `HOME` set to a fake home folder, `CODEX_HOME` to a hob-like Codex home and the working folder in a fake Git repository, asked with `skills/list` (`forceReload: true`). Claude Code 2.1.311 through the Agent SDK 0.3.311 (`@anthropic-ai/claude-agent-sdk` from npm), with the same kind of fake home and repository, read from its `system/init` message. Each place held one probe skill named after it. For turns, a stand-in played the model and recorded each request: for Codex a stand-in for the Responses API set as a custom model provider (`wire_api = "responses"`), as in the ADR 024 probe, and for Claude Code a stand-in for the Messages API (`ANTHROPIC_BASE_URL`, a throwaway API key). No account and no real model on either runtime. The Codex 0.166.0 source (tag `rust-v0.166.0`, `codex-rs/ext/skills` and `codex-rs/config`) was read for what the probe could not show.
- **Result:** Passed with gaps. Each runtime's loading path that ADR 029 relies on was observed, so was what it must turn off, and so was what a resumed session is offered after its skills change. claude.ai connectors, an administrator's skills and a real model were not observed.

## Codex 0.166.0

The places probed: `~/.agents/skills`, `~/.codex/skills`, `CODEX_HOME/skills`, the repository's `.agents/skills` and `.codex/skills`, and a root added with `skills/extraRoots/set`.

| Case | Check | Result |
|---|---|---|
| Probe | Plain hob `config.toml` | `CODEX_HOME/skills` (scope `user`), `~/.agents/skills` (`user`), the repository's `.agents/skills` and `.codex/skills` (`repo`) and five bundled skills (`system`) listed. `~/.codex/skills` not listed |
| Probe | The repository marked `trust_level = "untrusted"`, then `"trusted"` | ❌ No change: the repository's `.agents/skills` and `.codex/skills` listed either way |
| Probe | `project_root_markers = []` | ❌ No change |
| Probe | `[skills.bundled] enabled = false` | ✅ Bundled skills gone |
| Probe | One `[[skills.config]]` rule (`path` = the `SKILL.md`, `enabled = false`) for each skill in `~/.agents/skills`, `.agents/skills` and `.codex/skills` | ✅ Each listed as disabled; only `CODEX_HOME/skills` enabled |
| Probe | `skills/extraRoots/set` with one more folder | ✅ Its skill listed with scope `user` |
| Probe | The bundled-skills switch and the rules given as `-c skills.bundled.enabled=false` and `-c skills.config=[…]` on the App Server's command line, with an empty `config.toml` | ✅ Same result as in `config.toml` |
| Probe | A thread started with an extra root holding `alpha` (r1) and `gamma`, one turn, the process stopped; a new process given a root holding `alpha` (r2), `beta` and an Only when asked skill, `thread/resume`, one turn | ✅ The second request carried a new skills block listing `alpha` r2 and `beta` from the new root, with no `gamma` and no Only when asked skill; the first turn's block stayed in the history |
| Probe | `agents/openai.yaml` with `policy.allow_implicit_invocation: false` | Listed as enabled; `skills/list` does not report the policy, and the skill was left out of what the model was offered (above) |
| Source | Roots | `ext/skills/src/host_roots.rs`: per user layer `CODEX_HOME/skills` ("deprecated user skills location, kept for backward compatibility"), `$HOME/.agents/skills` and `CODEX_HOME/skills/.system`; per project layer its `skills`; per system layer its `skills` (scope `admin`); plugins; extra roots; and each `.agents/skills` from the project root to the working folder, with no trust check. No setting turns a root off |
| Source | Only when asked | `skills/src/metadata.rs` reads `policy.allow_implicit_invocation` from `agents/openai.yaml` |
| Source | A resumed thread | `ext/skills/src/catalog_delta.rs` publishes added and changed skills into the thread within one budget per context window |

## Claude Code 2.1.311

Options as the adapter passes them (`settingSources: []`), plus `plugins: [{ type: "local", path, skipMcpDiscovery: true }]` for a plugin folder that held two skills and an `.mcp.json`. The fake home held `~/.claude/skills`, `~/.agents/skills`, a `SessionStart` hook in `~/.claude/settings.json` and an MCP server in `~/.claude.json`; the repository held `.claude/skills`, `.agents/skills` and an MCP server in `.mcp.json`.

| Case | Check | Result |
|---|---|---|
| Probe | Skills listed | ✅ `hobbots-skills:hob-library-skill` and `hobbots-skills:only-when-asked` from the plugin; none from the home folder or the repository; Claude Code's own built-in skills |
| Probe | Plugins listed | ✅ The plugin, and Claude Code's own built-in plugins |
| Probe | MCP servers | ✅ None: not the home folder's, the repository's or the plugin's |
| Probe | The home folder's hook | ✅ Did not run |
| Probe | `skills: ["hobbots-skills:hob-library-skill"]` | The `system/init` listing did not change; the SDK documents the option as a filter on the model's listing and the Skill tool |
| Probe | With the stand-in: a session's first turn on a plugin with `alpha` (r1) and `gamma`; then a resumed session (`resume`) on a new plugin folder with `alpha` (r2), `beta` and `delta` (`disable-model-invocation: true`), `skills` naming all three | ✅ The first request listed only `hobbots-skills:alpha` and `hobbots-skills:gamma`, no built-in skill. The resumed request kept the first listing in its history and added a system message listing `alpha` r2 and `beta`, with neither `gamma` nor `delta` |
| Probe | In that resumed turn, the stand-in model calls the Skill tool for `hobbots-skills:gamma` | ✅ Refused: `Unknown skill: hobbots-skills:gamma` |

## Gaps

- No real model ran, so whether a model picks a skill from its description, and that a mention still runs an Only when asked skill, are not observed ([#1061](https://github.com/otaviobarros/hobbots/issues/1061)).
- An administrator's skills (Codex's system configuration, Claude Code's managed settings) were not probed, since writing them needs the system's folders ([#1061](https://github.com/otaviobarros/hobbots/issues/1061)).
- Two overlapping turns of one hob were not run; they read separate folders by design ([#1061](https://github.com/otaviobarros/hobbots/issues/1061)).
- claude.ai connectors need a real subscription sign-in ([#1061](https://github.com/otaviobarros/hobbots/issues/1061)).
- macOS and the Hobbots sandbox around either runtime were not part of the probe.
