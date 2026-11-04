import { ENFORCEMENT_CAPABILITIES, type EnforcementCapability, type RuntimeEnforcement } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@hobbots/ui/components/tooltip";
import { messages } from "../messages.ts";

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
          <li key={capability} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-ui">
            <Badge variant={STATUS_VARIANT[status]}>{copy.status[status]}</Badge>
            <span className="font-bold">{copy.capability[capability]}</span>
            <span className="basis-full text-detail text-text-secondary">{evidence}</span>
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

/**
 * The tag on a rule Hobbots decides but a permitted command could get around (ADR 014). The tag
 * alone does not say that, so it explains itself on hover and on keyboard focus.
 */
export function CheckedTag() {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge asChild variant="muted">
            <button type="button" className="cursor-default border-0">
              {messages.permissions.checked}
            </button>
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          <span className="whitespace-normal">{messages.permissions.checkedHint}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
