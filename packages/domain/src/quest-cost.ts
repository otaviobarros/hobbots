import { Schema } from "effect";
import { QuestId } from "./quest.ts";

/**
 * What a Quest cost (#1449): the tokens its whole party's replies and turns used, from the usage the
 * runtimes reported with them (OP-002). Nothing is estimated: replies and turns that reported no
 * usage are counted apart.
 */
export const QuestCost = Schema.Struct({
  /** The Quest at the top of the tree: a sub-quest's usage counts for it. */
  questId: QuestId,
  /** Every token its replies and turns read or wrote, cached or not. */
  tokens: Schema.Number,
  /** The replies and turns counted, and how many of them reported no usage. */
  turns: Schema.Number,
  unreported: Schema.Number,
});
export type QuestCost = typeof QuestCost.Type;

/** What a Quest's party spent, as the usage records sum it. */
export interface QuestSpend {
  readonly tokens: number;
  readonly turns: number;
  readonly unreported: number;
}
