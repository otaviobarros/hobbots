# Quest

Written by `scripts/machines.mjs` from `QuestMachine` in `packages/domain/src/quest.ts`. Do not edit it by hand: change the machine and run `pnpm docs:machines`.

Its state is in the `state` field.

| State | Meaning |
| --- | --- |
| active | Under way: its lead works on it with its party |
| stopping | Its lead stopped it at your request; the work under it is being cancelled |
| completed | Its lead said it delivered what you asked for |
| failed | Its Task failed; a retry or another hob reopens it |
| cancelled | You cancelled it |
| stopped | Its lead stopped it at your request, without delivering it |

```mermaid
stateDiagram-v2
  active --> stopping: Stop
  active --> completed: Complete
  active --> failed: Fail
  stopping --> stopped: Cancel
  active --> cancelled: Cancel
  failed --> active: Reopen
  completed --> [*]
  cancelled --> [*]
  stopped --> [*]
```

| Event | From | To | Guarded |
| --- | --- | --- | --- |
| Stop | active | stopping | no |
| Complete | active | completed | no |
| Fail | active | failed | no |
| Cancel | stopping | stopped | no |
| Cancel | active | cancelled | no |
| Reopen | failed | active | no |
