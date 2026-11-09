import type { SummoningScope } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@hobbots/ui/components/menu";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { agentsQuery } from "../../api/queries.ts";
import { messages } from "./messages.ts";
import { ReadFailed } from "./read-failed.tsx";
import { pickHob } from "./summoning-model.ts";
import { SUMMONING_ROW } from "./summoning-row.ts";

/**
 * The hobs you picked for the hob to manage too, each with a remove button, and a menu to add one.
 * While the hobs are read, each picked hob holds a block and the menu waits; when they cannot be
 * read, the row says so with Try again.
 */
export function PickedHobs({
  name,
  self,
  scope,
  pending,
  onChange,
}: {
  name: string;
  /** The hob's own id, left out of the menu, or null in Settings. */
  self: string | null;
  scope: SummoningScope;
  pending: boolean;
  onChange: (scope: SummoningScope) => void;
}) {
  const copy = messages.scope;
  const hobs = useQuery(agentsQuery);
  return (
    <div className={cn(SUMMONING_ROW, "flex-col")}>
      <span className="flex flex-col">
        <span className="text-text-strong">{copy.picked}</span>
        <span className="text-detail text-text-secondary">
          {scope.hobs.length === 0 ? copy.nonePicked({ name }) : copy.pickedNote({ name })}
        </span>
      </span>
      {hobs.isError && hobs.data === undefined ? (
        <ReadFailed text={copy.hobsFailed} retry={() => void hobs.refetch()} />
      ) : (
        <>
          {scope.hobs.length > 0 && (
            <ul aria-label={copy.pickedList} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {scope.hobs.map((id) => {
                const hob = hobs.data?.find((each) => each.id === id);
                const label = hob?.name ?? copy.someHob;
                return (
                  <li
                    key={id}
                    className="inline-flex items-center gap-1 rounded-tag bg-card ps-2 text-detail text-text-strong shadow-[inset_0_0_0_1px_var(--color-line)]"
                  >
                    {hobs.data === undefined ? <Skeleton surface="card" width="6ch" /> : label}
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={pending}
                      aria-label={copy.remove({ hob: hobs.data === undefined ? copy.aHob : label })}
                      onClick={() => onChange(pickHob(scope, id, false))}
                    >
                      <span aria-hidden>×</span>
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="xs" className="self-start" disabled={pending || hobs.data === undefined}>
                {copy.add}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <HobChoices
                hobs={(hobs.data ?? []).filter((hob) => hob.id !== self && !scope.hobs.includes(hob.id))}
                onPick={(id) => onChange(pickHob(scope, id, true))}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  );
}

/** The hobs left to pick, or a line saying every hob is picked. */
function HobChoices({
  hobs,
  onPick,
}: {
  hobs: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  onPick: (id: string) => void;
}) {
  if (hobs.length === 0) return <DropdownMenuLabel>{messages.scope.noMore}</DropdownMenuLabel>;
  return hobs.map((hob) => (
    <DropdownMenuItem key={hob.id} onSelect={() => onPick(hob.id)}>
      {hob.name}
    </DropdownMenuItem>
  ));
}
