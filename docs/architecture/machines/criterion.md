# Criterion

Written by `scripts/machines.mjs` from `CriterionMachine` in `packages/domain/src/criterion.ts`. Do not edit it by hand: change the machine and run `pnpm docs:machines`.

Its state is in the `state` field.

| State | Meaning |
| --- | --- |
| open | Nobody has checked it yet, or a newer version voided the evidence it was accepted on |
| accepted | Its lead checked it against evidence that still holds |
| needs-rework | Its lead found the work does not meet it yet |
| waived | It no longer has to hold: you waived it, or its lead waived an optional one |

```mermaid
stateDiagram-v2
  open --> accepted: Accept (guarded)
  needs-rework --> accepted: Accept (guarded)
  open --> needs-rework: Rework
  accepted --> needs-rework: Rework
  open --> waived: Waive (guarded)
  accepted --> waived: Waive (guarded)
  needs-rework --> waived: Waive (guarded)
  accepted --> open: Void (guarded)
  waived --> [*]
```

| Event | From | To | Guarded |
| --- | --- | --- | --- |
| Accept | open, needs-rework | accepted | yes |
| Rework | open, accepted | needs-rework | no |
| Waive | open, accepted, needs-rework | waived | yes |
| Void | accepted | open | yes |
