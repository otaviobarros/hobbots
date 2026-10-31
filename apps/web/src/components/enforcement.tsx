import { ENFORCEMENT_CAPABILITIES, type EnforcementCapability, type RuntimeEnforcement } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { messages } from "./messages.ts";

const copy = messages.enforcement;

const STATUS_VARIANT = { verified: "done", unverified: "waiting", unsupported: "failed" } as const satisfies Record<
  EnforcementCapability["status"],
  string
>;

/**
 * What a runtime enforces on this hub, one row per capability with its status and evidence (ADR 014).
 * Provider health and the hob profile both show it, so neither claims more than the adapter does.
 */
export function EnforcementList({ enforcement }: { enforcement: RuntimeEnforcement }) {
  return (
    <ul aria-label={copy.listLabel} className="m-0 flex list-none flex-col gap-1.5 p-0">
      {ENFORCEMENT_CAPABILITIES.map((capability) => {
        const { status, evidence } = enforcement[capability];
        return (
          <li key={capability} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
            <Badge variant={STATUS_VARIANT[status]}>{copy.status[status]}</Badge>
            <span className="font-bold">{copy.capability[capability]}</span>
            <span className="basis-full text-[13px] text-secondary-text">{evidence}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** The tag on an action the hub blocks because the sandbox cannot start. */
export function NeedsSandbox() {
  return <Badge variant="blocked">{copy.needsSandbox}</Badge>;
}
