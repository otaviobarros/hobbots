import { Schema } from "effect";
import { Criteria, type Criterion } from "./criterion.ts";
import { QuestId } from "./quest.ts";

/**
 * A Quest's cost per accepted outcome (#1449): the tokens its whole party's replies and turns used,
 * from the usage the runtimes reported with them (OP-002), divided by the acceptance criteria
 * accepted on evidence (#1445). A waived criterion is no accepted outcome, so it does not count.
 * Nothing is estimated: replies and turns that reported no usage are counted apart, and with nothing
 * accepted yet there is no cost per outcome to show.
 */
export const QuestCost = Schema.Struct({
  /** The Quest at the top of the tree: a sub-quest's usage counts for it. */
  questId: QuestId,
  /** Every token its replies and turns read or wrote, cached or not. */
  tokens: Schema.Number,
  /** The replies and turns counted, and how many of them reported no usage. */
  turns: Schema.Number,
  unreported: Schema.Number,
  /** Its criteria accepted on evidence, and how many it has. */
  accepted: Schema.Number,
  criteria: Schema.Number,
  /** Tokens per accepted criterion, rounded to a whole token; null while none is accepted. */
  perAccepted: Schema.NullOr(Schema.Number),
});
export type QuestCost = typeof QuestCost.Type;

/** What a Quest's party spent, as the usage records sum it. */
export interface QuestSpend {
  readonly tokens: number;
  readonly turns: number;
  readonly unreported: number;
}

/** A Quest's cost per accepted outcome, from what its party spent and its criteria as they stand. */
export const questCost = (questId: QuestId, spend: QuestSpend, criteria: ReadonlyArray<Criterion>): QuestCost => {
  const accepted = criteria.filter(Criteria.accepted).length;
  return {
    questId,
    ...spend,
    accepted,
    criteria: criteria.length,
    perAccepted: accepted === 0 ? null : Math.round(spend.tokens / accepted),
  };
};
