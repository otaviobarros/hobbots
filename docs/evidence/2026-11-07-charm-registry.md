# The Charm registry and the Charm-id grant

- **Date:** 2026-11-07
- **Issue:** [#620](https://github.com/otaviobarros/hobbots/issues/620)
- **Pull request:** opened from `claude/project-thread-tozd4q`
- **Commit:** first run on `029b2c51f939db2aff17a41fb1b6df311bd61396`; the suites below re-ran on the commit after it, which adds `[TC-PE-511]`, with a clean tree
- **Setup:** Linux x86_64 container, Node 22.23.4. The registry suites ran with fake Charms, the real GitHub Charm against a fake GitHub, the fake runtime, the real policy engine and in-memory call records; the persistence and server suites ran on SQLite and on PostgreSQL 16 (the same environment `pnpm test:pg` sets, on a local server instead of Docker). No account, real model or real GitHub was used.
- **Result:** Passed with gaps: the Charms are a list registered once, a hob holds a set of Charm ids, a duplicate or over-long tool name stops the hub, taking a Charm away stops the hob's running turn, and one never-twice runner serves every Charm; the GitHub Charm behaves as before.

## Checks

| Case | Check | Result |
|---|---|---|
| `[TC-PE-500]` | Joined hub tools keep their order and owners, and a name two sets offer is refused naming both | ✅ |
| `[TC-PE-501]` | A hob holding two fake Charms is offered both lists, one holding one only that one; a Charm not connected or not held offers nothing; a session without a reply gets no writes | ✅ |
| `[TC-PE-502]` | A duplicate across Charms, within one, or with a built-in hub tool stops the hub naming both owners; a name over 64 characters stops it naming that name; 64 is accepted | ✅ |
| `[TC-PE-503]` | One runner records two Charms' writes under their own names, and its startup scan reads back both Charms' unsettled calls | ✅ |
| `[TC-PE-504]`, `[TC-PE-505]` | `narrows` stops a turn when a Charm is taken away or a Charm operation's answer narrows, and not when one is given or widens | ✅ |
| `[TC-PE-506]` | Taking a Charm away revokes the grants that relied on it: its sites and the built-in requests it takes over | ✅ |
| `[TC-PE-507]` | Charms are granted by id through the API, keep their overrides, and a Charm the hub does not hold is refused | ✅ |
| `[TC-PE-511]` | A Charm registered with the registry and declared nowhere else is granted through the API, its operations get their preset answers and a narrowing override, and a Charm the registry does not hold is refused. It fails when the hub's declarations are supplied apart from the registry | ✅ |
| `[TC-PE-508]` | Through the hub with the fake runtime, a running turn stops once its hob loses a Charm, and goes on when it gains one | ✅ |
| `[TC-PE-509]` | The real GitHub Charm registered beside a fake second Charm: both offered to a hob holding both, only one to a hob holding one | ✅ |
| `[TC-PE-510]` | Policies stored or journaled with `githubCharm` decode to the set it meant, and the flag is never written again | ✅ |
| `[TC-DP-290]` | 0076 turns `github_charm` into the Charm id set on the hob and every version, on SQLite and PostgreSQL; a hob with the Charm on still holds it | ✅ |
| `[TC-AG-165]` | A skill's Charm hint is matched against the hob's set of Charm ids | ✅ |
| GitHub Charm suites | `packages/charms/test`, the server's GitHub Charm, hob app and hob identity end-to-end suites, `[TC-PE-144]` (the on/off switch) and `[TC-PE-146]` (the switch through the API) | ✅ Without a loosened assertion |

## Behaviour that changes on purpose (ADR 031)

- A hob's policy now names its Charms: `charms.granted` is `["github"]` for a hob that had the GitHub Charm, and `[]` where the policy said `githubCharm: false`. The assertions on a hob's whole policy in `[TC-AG-090]`, `[TC-AG-101]` and `[TC-PE-146]` gained that field, and the GitHub Charm e2e reads `charms.granted` where it read `githubCharm`.
- A tool name two owners share stops the hub, where `combineHubTools` gave it to the first set without saying so. The test of that rule now checks the refusal.
- Turning a Charm off revokes the grants that relied on it, for any Charm. Before, turning the GitHub Charm off kept them.
- The fake runtime reports that it serves hub tools, which it does; the Claude Code and Codex capability text names what they serve.

## Gaps

- `[TC-DP-008]` fails in this container on SQLite and PostgreSQL, before and after this change: it has no IPv6, so `::1` cannot be reached.
- `[TC-OR-458]` timed out once at 5 s in the full PostgreSQL server run, and passed run alone. It is flaky in this container, as recorded for #619, and touches no hub tool.
- macOS, the packaged app and the browser e2e suites were not run, so `hob-profile.e2e.ts` and `github-charm.e2e.ts` were not run here.
- Turbo could not start its tasks in this container (`Exec format error`), so each step of `pnpm check` ran on its own: the standards, layer, complexity, frontend, script, knip, jscpd and Biome checks, each package's typecheck, and each package's tests.
- Docker was not available, so the PostgreSQL run used a local PostgreSQL 16 server on the port `pnpm test:pg` uses.
- No installed Claude Code or Codex ran in this change. The registry runs on the hub, the same whatever the runtime, and a turn is stopped by the hub's own review of its authority, which every runtime's turn goes through.
