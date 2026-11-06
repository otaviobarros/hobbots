# A five-hob party Quest on real Claude Code counts each member's spend and keeps each member's memory

- **Date:** 2026-11-05
- **Issue:** [#1011](https://github.com/otaviobarros/hobbots/issues/1011), [#1012](https://github.com/otaviobarros/hobbots/issues/1012)
- **Pull request:** [#1025](https://github.com/otaviobarros/hobbots/pull/1025)
- **Commit:** `da6501f` on `main`, which holds `e1cf987` ([#1017](https://github.com/otaviobarros/hobbots/pull/1017)), `c99ca96` ([#1019](https://github.com/otaviobarros/hobbots/pull/1019)) and `2e1f63d` ([#1022](https://github.com/otaviobarros/hobbots/pull/1022))
- **Setup:** Apple silicon Mac, arm64, an ad hoc signed `pnpm package:mac` build started with a new data folder (`--user-data-dir`) and `HOBBOTS_MODE=hub`, never the Mac's Hobbots data, with opening at login off. Claude Code 2.1.316 on a signed-in subscription. Five hobs, all on Claude Code with the `haiku` model, under the Balanced preset, with one approved folder. ai-memory as bundled, with the default memory model. The run was driven through the app's own window.
- **Result:** Passed with gaps. Usage counts every member's turns under its own name, a turn woken again by a background command counts both runs, and every token figure matches the Claude Code transcripts. Each member's Attempt became a session page in its own memory. The Quest's commit step did not finish, because the Mac has no Git identity and a hob cannot set one.

## The Quest

One message to Frodo (the lead) asked for a small Python CLI, "Tide Table", in the approved folder. Frodo planned two steps of his own, started the Quest and delegated three Tasks with milestones: Quill (backend, tests first), Rook (frontend, depending on Quill's Task) and Pip (tech lead, depending on both). Pip led a Quest of its own and delegated to Nettle (platform). The run exercised `plan_steps`, `start_quest`, `delegate_task`, `hand_off`, `ask` and `answer` (Quill's question, answered by the lead), `escalate` (Rook's question, answered by you), a note steered from the chat column, `report_checkpoint`, `wait_for`, two approvals for deletes, a background command and `memory_save` by each member. It ran from 22:31 to 22:43 (UTC−3) and ended Finished, with Nettle's Task cancelled.

## Checks

| Case | Check | Result |
|---|---|---|
| Party | Frodo's two steps ran, then Quill, Rook, Pip and Pip's member Nettle each ran in their own session, and the room showed a lane per hob with Pip's party nested | ✅ |
| Hand-off and questions | Quill's result was handed to Rook. Quill's question was answered by Frodo. Rook's question was escalated, answered with Metres from the chat column, and reached Rook | ✅ |
| Steered note | "Quill, also add a test for an empty CSV file." sent from the chat column while Quill worked was passed to Quill, which added the tests | ✅ |
| Usage by hob (#1011) | Usage › Who used what lists Frodo, Pip, Nettle, Quill and Rook each under its own name, with Claude Code · haiku | ✅ |
| Usage by Quest (#1011) | The Quest's row counts its five hobs and 96% of the tokens. The other 4% is Frodo's two steps, planned before the Quest started | ✅ |
| Turns recorded (#1011) | 28 `attempt_turns` rows, none unreported and none left open | ✅ |
| Against transcripts (#1011) | For every hob, the input, output, cache-creation and cache-read tokens in the database equal the sums from its Claude Code session transcripts. Output tokens: Frodo's chat 19,640 over 19 replies, Frodo's steps 3,738 over 2 turns, Quill 8,261 over 3, Rook 5,179 over 3, Pip 19,560 over 14 and Nettle 9,526 over 6. All four columns total 6,780,539 tokens | ✅ |
| Woken turn (#1011) | Quill's second turn ran twice: once, then again when Claude Code woke it for its background `sleep 20`. Its row is the exact sum of both runs | ✅ |
| Member sessions (#1012) | Quill, Rook, Pip and Nettle each have one session page named by its Attempt's id, in its own memory, summarized, with the Task's goal, its tool steps and its replies | ✅ |
| Lead's memory (#1012) | Frodo's memory holds only the session pages of his own two steps, none for a member's Attempt | ✅ |
| Nothing twice (#1012) | Each session's stops equal its turns, and each engine session ended once with its summary written | ✅ |
| Saves (#1012) | Each member's `memory_save` is a note in its own memory: Quill's UTC rule, Rook's unit, Pip's review lesson and how Nettle wired `make check` | ✅ |
| Secrets (#1012) | No secret in any page or observation | ✅ |
| Commit | Nettle's `git commit` failed for lack of an identity. Hobbots refused `git config` and `git -c user.name=…`, as it should. The answers to its questions could not supply one, and Nettle's Task was cancelled with its files staged | ❌ See the findings |

## Findings

- A hob is told to ask who to commit as when no Git identity is set, but no answer lets it commit: it cannot set an identity, and Hobbots does not set one for it. Six of the eight questions in the run were about this.
- Nettle's session summary says the lead's answer never arrived, while the hub shows all three of its questions answered.
- Usage's note under Who used what still says Task steps aren't counted yet, which #1017 changed.
- Eight Task tool calls were refused, each for a reason the hub states: `wait_for` on the hob's own question id (Rook and Nettle), a milestone name that did not match (Frodo), and `complete_task` with milestones, children or items still open (Nettle and Pip).
- ai-memory logged 106 warnings for a workspace or project not found. Whether these are lookups of scopes with no pages yet was not checked.

## Gaps

- Retries, redelivery and redaction were not exercised on the real runtime: no Task was retried and no secret reached memory. The fake-runtime and ai-memory tests in #1017 and #1019 cover them.
- Frodo's own thread session is still open, as a thread's session is until it goes quiet or is archived, so its summary was not checked.
- No Codex hob took part.
