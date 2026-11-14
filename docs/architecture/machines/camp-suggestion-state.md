# CampSuggestionState

Written by `scripts/machines.mjs` from `CampSuggestionStateMachine` in `packages/domain/src/camp-suggestion.ts`. Do not edit it by hand: change the machine and run `pnpm docs:machines`.

Its state is in the `state` field.

| State | Meaning |
| --- | --- |
| pending | Raised; the hub checks its chapter holds one topic and names the camp before offering it |
| open | Offered in the chat, with Make a camp and Keep in chat |
| kept | You kept the chapter in the chat; it is never offered again |
| accepted | The chapter moved into a camp |
| expired | Its chapter holds several topics, was merged away, or its chat closed, so it is not offered |

```mermaid
stateDiagram-v2
  pending --> open: Offer
  pending --> expired: Withdraw
  open --> kept: Keep
  pending --> accepted: Accept (guarded)
  open --> accepted: Accept (guarded)
  pending --> expired: Expire
  open --> expired: Expire
  kept --> [*]
  accepted --> [*]
  expired --> [*]
```

| Event | From | To | Guarded |
| --- | --- | --- | --- |
| Offer | pending | open | no |
| Withdraw | pending | expired | no |
| Keep | open | kept | no |
| Accept | pending, open | accepted | yes |
| Expire | pending, open | expired | no |
