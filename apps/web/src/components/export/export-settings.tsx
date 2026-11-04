import type { AgentId, ExportScope } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { agentsQuery } from "../../api/queries.ts";
import { ExportForm } from "./export-form.tsx";
import { messages as copy } from "./messages.ts";

type Pick = "everything" | "hob";

/** The scope the choice names: everything, or the hob picked, or the first hob until one is. */
const scopeOf = (pick: Pick, hobId: AgentId | undefined): ExportScope | null => {
  if (pick === "everything") return { _tag: "Everything" };
  return hobId === undefined ? null : { _tag: "Hob", agentId: hobId };
};

/** Settings › Export: everything, or one hob, saved as a folder on the hub (ADR 026). */
export function ExportSettings() {
  const hobs = useQuery(agentsQuery);
  const [pick, setPick] = useState<Pick>("everything");
  const [picked, setPicked] = useState<AgentId | null>(null);
  const name = useId();
  const selectId = useId();
  const hobId = picked ?? hobs.data?.[0]?.id;
  const radio = "flex items-center gap-2 text-sm";

  return (
    <>
      <p className="m-0 text-text-secondary">{copy.intro}</p>
      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend className="lbl mb-1.5 p-0 text-xs text-label">{copy.what}</legend>
        <label className={radio}>
          <input
            type="radio"
            name={name}
            checked={pick === "everything"}
            onChange={() => setPick("everything")}
            className="accent-lantern"
          />
          {copy.everything}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <label className={radio}>
            <input
              type="radio"
              name={name}
              checked={pick === "hob"}
              onChange={() => setPick("hob")}
              disabled={(hobs.data ?? []).length === 0}
              className="accent-lantern"
            />
            {copy.oneHob}
          </label>
          {pick === "hob" && (
            <>
              <label htmlFor={selectId} className="sr-only">
                {copy.hob}
              </label>
              <select
                id={selectId}
                value={hobId ?? ""}
                onChange={(event) => setPicked(event.target.value as AgentId)}
                className="min-w-0 border-2 border-control bg-deep px-2 py-1 text-[13px] text-text-strong"
              >
                {(hobs.data ?? []).map((hob) => (
                  <option key={hob.id} value={hob.id}>
                    {hob.name}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
      </fieldset>
      <ExportForm scope={scopeOf(pick, hobId)} />
    </>
  );
}
