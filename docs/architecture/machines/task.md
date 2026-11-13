# Task

Written by `scripts/machines.mjs` from `TaskMachine` in `packages/domain/src/task.ts`. Do not edit it by hand: change the machine and run `pnpm docs:machines`.

Its state is in the `state` field.

| State | Meaning |
| --- | --- |
| queued | Waiting for its first Attempt, or for the next one after a retry or reassignment |
| active | An Attempt is running |
| waiting | Waiting on a dependency, an approval or an answer |
| blocked | Waiting for a decision from outside its turn: its lead's, or for a step its owner's |
| pausing | You paused it while its turn ran; no turn starts once that one ends |
| paused | You paused it; no turn starts on it until you resume it |
| cancelling | A cancel was requested and is not confirmed yet |
| completed | Done, with its result |
| failed | Ended without a result; a retry or reassignment reopens it |
| cancelled | Stopped, and the stop is confirmed |

```mermaid
stateDiagram-v2
  active --> waiting: Wait
  pausing --> pausing: Wait
  active --> blocked: Block
  waiting --> blocked: Block
  pausing --> pausing: Block
  waiting --> active: Resume
  blocked --> active: Resume
  queued --> failed: Fail
  active --> failed: Fail
  waiting --> failed: Fail
  blocked --> failed: Fail
  pausing --> failed: Fail
  paused --> failed: Fail
  queued --> cancelling: RequestCancel
  active --> cancelling: RequestCancel
  waiting --> cancelling: RequestCancel
  blocked --> cancelling: RequestCancel
  pausing --> cancelling: RequestCancel
  paused --> cancelling: RequestCancel
  queued --> cancelled: Cancel
  paused --> cancelled: Cancel
  cancelling --> cancelled: Cancel
  queued --> active: Start (guarded)
  active --> active: Start (guarded)
  waiting --> active: Start (guarded)
  blocked --> active: Start (guarded)
  failed --> active: Start (guarded)
  failed --> queued: Retry
  queued --> queued: Reassign
  active --> queued: Reassign
  waiting --> queued: Reassign
  blocked --> queued: Reassign
  failed --> queued: Reassign
  active --> completed: Complete
  waiting --> completed: Complete
  blocked --> completed: Complete
  pausing --> completed: Complete
  active --> pausing: Pause (guarded)
  queued --> paused: Pause
  active --> paused: Pause
  waiting --> paused: Pause
  blocked --> paused: Pause
  pausing --> paused: PauseSettled
  paused --> queued: Unpause (guarded)
  paused --> active: Unpause (guarded)
  paused --> waiting: Unpause (guarded)
  paused --> blocked: Unpause (guarded)
  pausing --> active: Unpause
  completed --> [*]
  cancelled --> [*]
```

| Event | From | To | Guarded |
| --- | --- | --- | --- |
| Wait | active | waiting | no |
| Wait | pausing | pausing | no |
| Block | active, waiting | blocked | no |
| Block | pausing | pausing | no |
| Resume | waiting, blocked | active | no |
| Fail | queued, active, waiting, blocked, pausing, paused | failed | no |
| RequestCancel | queued, active, waiting, blocked, pausing, paused | cancelling | no |
| Cancel | queued, paused, cancelling | cancelled | no |
| Start | queued, active, waiting, blocked, failed | active | yes |
| Retry | failed | queued | no |
| Reassign | queued, active, waiting, blocked, failed | queued | no |
| Complete | active, waiting, blocked, pausing | completed | no |
| Pause | active | pausing | yes |
| Pause | queued, active, waiting, blocked | paused | no |
| PauseSettled | pausing | paused | no |
| Unpause | paused | queued | yes |
| Unpause | paused | active | yes |
| Unpause | paused | waiting | yes |
| Unpause | paused | blocked | yes |
| Unpause | pausing | active | no |
