import type { Agent, Grant } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useRevokeGrant } from "../../api/grants.ts";
import { ruleText } from "../approvals/approval-rules.ts";
import { HobSprite } from "../hob-sprite.tsx";
import { messages } from "./messages.ts";
import { ruleMeta } from "./standing-rules.ts";

const copy = messages;

/**
 * One standing rule. Remove rule asks first, in the row; Remove then revokes it, and Keep it or
 * Escape takes the question back with focus on Remove rule.
 */
export function StandingRuleRow({ grant, hob }: { grant: Grant; hob: Agent | undefined }) {
  const [confirming, setConfirming] = useState(false);
  const revoke = useRevokeGrant();
  const name = hob?.name ?? copy.unknownHob;
  const rule = ruleText(grant.rule, name);
  const keep = useRef<HTMLButtonElement>(null);
  const start = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);

  // Focus follows the question: onto it when it opens, back to Remove rule when it closes.
  useEffect(() => {
    if (confirming) keep.current?.focus();
    else if (asked.current) start.current?.focus();
    asked.current = confirming;
  }, [confirming]);

  const cancel = () => {
    revoke.reset();
    setConfirming(false);
  };

  return (
    <li
      data-grant={grant.id}
      className="flex flex-col gap-2 border-b-2 border-line py-2.75 last:border-b-0"
      onKeyDown={(event) => {
        if (confirming && event.key === "Escape" && !revoke.isPending) {
          event.stopPropagation();
          cancel();
        }
      }}
    >
      <div className="flex items-center gap-3">
        {hob && <HobSprite hob={hob} size={22} />}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm wrap-anywhere">{rule}</span>
          <span className="flex flex-wrap gap-x-2 text-xs text-label">
            <span>{ruleMeta(grant)}</span>
            {grant.approvalId !== null && (
              <Link
                to="/inbox"
                search={{ tab: "all", request: grant.approvalId }}
                aria-label={copy.requestLabel({ rule })}
                className="text-lantern no-underline hover:underline"
              >
                {copy.request}
              </Link>
            )}
          </span>
        </span>
        {!confirming && (
          <Button
            ref={start}
            variant="deny"
            size="xs"
            aria-label={copy.removeLabel({ rule })}
            onClick={() => setConfirming(true)}
          >
            {copy.remove}
          </Button>
        )}
      </div>
      {confirming && (
        <fieldset
          aria-label={copy.removeLabel({ rule })}
          disabled={revoke.isPending}
          className="cut m-0 flex animate-hb-in flex-col gap-2 border-2 border-solid border-rose bg-deep px-3 py-2.5"
        >
          <span className="text-sm">{copy.confirm.question({ name })}</span>
          {grant.rule._tag === "Host" && (
            <span className="text-xs text-secondary-text">{copy.confirm.hostNote({ name })}</span>
          )}
          {revoke.isError && (
            <span role="alert" className="text-sm text-rose">
              {copy.removeFailed}
            </span>
          )}
          <div className="flex gap-2">
            <Button variant="deny" size="sm" onClick={() => revoke.mutate(grant.id)}>
              {revoke.isPending ? copy.confirm.removing : copy.confirm.remove}
            </Button>
            <Button ref={keep} variant="outline" size="sm" onClick={cancel}>
              {copy.confirm.keep}
            </Button>
          </div>
        </fieldset>
      )}
    </li>
  );
}
