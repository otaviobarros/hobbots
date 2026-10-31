# Contributing to Hobbots

Thanks for helping build Hobbots. Start here:

- **Issues and planning:** [how issues, labels, triage and the project board work](docs/contributing/issues-and-board.md).
- **Code and architecture:** the [engineering standards](docs/standards/README.md) hold the rules every change follows, each with a stable ID. [AGENTS.md](AGENTS.md) lists the docs to read for each area, for people and coding agents alike.
- **Running it:** see [Run from source](README.md#run-from-source) in the README, and run `pnpm check` before opening a pull request.
- **Commits:** use [Conventional Commits](https://www.conventionalcommits.org/); they decide the next version, as [Releases](docs/contributing/releases.md) explains.

Report security vulnerabilities privately through the repository's Security tab, not in a public issue.

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).

## Coding agents

Hobbots uses the [agent-engineering](https://github.com/otaviobarros/agent-engineering) plugin so every coding agent follows the same workflow: plan with acceptance criteria, implement, verify, review independently, then publish only what you authorized. The [project workflow guide](docs/agent-engineering.md) maps tasks to its skills and to the project's own rules.

- **Claude Code:** the repository registers the plugin in [`.claude/settings.json`](.claude/settings.json). Trust the folder when you open it and accept the plugin prompt; `/plugin` shows its status.
- **Codex:** install it once with `codex plugin marketplace add otaviobarros/agent-engineering` and `codex plugin add agent-engineering@agent-engineering`.

Ask for an outcome and a finish line, for example "Use deliver-change to implement #42; open a draft PR, do not merge", or "Use plan-change to plan #42 and stop before code". Keep personal settings in `.claude/settings.local.json`, which is not committed.
