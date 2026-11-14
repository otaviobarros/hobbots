import type { Agent, HobChange } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useSavingPermissions, useUpdatePermissions } from "../../api/queries.ts";
import { restoreOf } from "./hob-changes-model.ts";
import { messages } from "./messages.ts";

const copy = messages.row;

/**
 * What a Summoning change dropped without naming it, with Restore them, which gives those answers
 * back as a change made by you (#1352). Nothing is restored until you press it.
 */
export function RestoreAnswers({ change, hob }: { change: HobChange; hob: Agent | undefined }) {
  const restore = restoreOf(change, hob);
  const update = useUpdatePermissions(change.hobId);
  // Each payload is built from the hob's policy as it stands, so one restore waits for another of
  // the same hob to save: two at once would each leave out what the other restores.
  const saving = useSavingPermissions(change.hobId);
  if (restore === null) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded-control border border-line bg-deep px-3 py-2">
      <span className="text-meta text-text-secondary">{copy.dropped({ answers: restore.words })}</span>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={saving}
          onClick={() => update.mutate(restore.payload)}
        >
          {update.isPending ? copy.restoring : copy.restore}
        </Button>
        {update.isError && (
          <span role="alert" className="text-meta text-rose">
            {copy.restoreFailed}
          </span>
        )}
      </div>
    </div>
  );
}
