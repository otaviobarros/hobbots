import type { Quest, TaskTree } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { questCostQuery } from "../../api/quest-cost.ts";
import { workCard } from "../quest/work-model.ts";
import { messages } from "./messages.ts";

const copy = messages.sheet;

/**
 * What the quest cost (#1449): the tokens its party's replies and turns reported, as the hub sums
 * them. Replies that reported no usage are counted apart, never estimated.
 */
export function QuestCost({ tree }: { tree: TaskTree }) {
  const quest = workCard(tree)?.quest ?? null;
  return quest === null ? null : <CostOf quest={quest} />;
}

function CostOf({ quest }: { quest: Pick<Quest, "id" | "revision"> }) {
  const read = useQuery(questCostQuery(quest));
  const cost = read.data;
  return (
    <section aria-label={copy.cost} className="flex flex-col gap-0.5">
      <h3 className="m-0 text-meta font-semibold text-label">{copy.cost}</h3>
      {cost === undefined && read.isError ? (
        <p className="m-0 flex flex-wrap items-center gap-2 text-detail text-text-secondary">
          <span role="alert">{copy.costUnread}</span>
          <Button type="button" variant="chip" size="xs" onClick={() => void read.refetch()}>
            {copy.costRetry}
          </Button>
        </p>
      ) : cost === undefined ? (
        <span role="status" className="text-detail text-text-secondary">
          {copy.costReading}
        </span>
      ) : (
        <>
          <span className="text-ui text-text-strong">{copy.costSpent({ tokens: cost.tokens, turns: cost.turns })}</span>
          {cost.unreported > 0 && (
            <span className="text-detail text-text-secondary">{copy.costUnreported({ count: cost.unreported })}</span>
          )}
        </>
      )}
    </section>
  );
}
