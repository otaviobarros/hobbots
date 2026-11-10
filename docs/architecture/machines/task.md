# Task

Written by `scripts/machines.mjs` from `TaskMachine` in `packages/domain/src/task.ts`. Do not edit it by hand: change the machine and run `pnpm docs:machines`.

States, in its `state` field: `queued`, `active`, `waiting`, `blocked`, `cancelling`, `completed`, `failed`, `cancelled`.

```mermaid
stateDiagram-v2
  active --> waiting: Wait
  active --> blocked: Block
  waiting --> blocked: Block
  waiting --> active: Resume
  blocked --> active: Resume
  queued --> failed: Fail
  active --> failed: Fail
  waiting --> failed: Fail
  blocked --> failed: Fail
  queued --> cancelling: RequestCancel
  active --> cancelling: RequestCancel
  waiting --> cancelling: RequestCancel
  blocked --> cancelling: RequestCancel
  queued --> cancelled: Cancel
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
  completed --> [*]
  cancelled --> [*]
```

| Event | From | To | Guarded |
| --- | --- | --- | --- |
| Wait | active | waiting | no |
| Block | active, waiting | blocked | no |
| Resume | waiting, blocked | active | no |
| Fail | queued, active, waiting, blocked | failed | no |
| RequestCancel | queued, active, waiting, blocked | cancelling | no |
| Cancel | queued, cancelling | cancelled | no |
| Start | queued, active, waiting, blocked, failed | active | yes |
| Retry | failed | queued | no |
| Reassign | queued, active, waiting, blocked, failed | queued | no |
| Complete | active, waiting, blocked | completed | no |
