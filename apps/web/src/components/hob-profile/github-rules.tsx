import type { HobPermissions, UpdateHobPermissionsPayload } from "@hobbots/api";
import { useId } from "react";
import { GITHUB_OPERATIONS, pickAnswer, RULES, type RuleInfo, sendingAnswer } from "../../api/safety.ts";
import { messages } from "../messages.ts";
import { Rule, RuleWaiting } from "./hob-permissions.tsx";

/** Allow, Ask or Never for each of the Charm's actions, saved at once as the hob's next version. */
export function GitHubRules({
  name,
  permissions,
  sending,
  pending,
  onPick,
}: {
  name: string;
  /** The hob's permissions, or undefined while the hub reads them. */
  permissions: HobPermissions | undefined;
  /** The change on its way to the hub. */
  sending: UpdateHobPermissionsPayload | undefined;
  pending: boolean;
  onPick: (change: UpdateHobPermissionsPayload) => void;
}) {
  const copy = messages.charms.github;
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5">
      <h3 id={headingId} className="lbl m-0 text-label">
        {copy.mayDo({ name })}
      </h3>
      {GITHUB_RULES.map((rule) =>
        permissions === undefined ? (
          <RuleWaiting key={rule.operation} rule={rule} icon={ICONS[rule.operation]} />
        ) : (
          <Rule
            key={rule.operation}
            rule={rule}
            icon={ICONS[rule.operation]}
            permissions={permissions}
            shown={sendingAnswer(permissions, sending, rule.operation)}
            pending={pending}
            onPick={(answer) => onPick(pickAnswer(permissions, rule.operation, answer))}
          />
        ),
      )}
      <span className="text-detail text-label">{copy.rulesNote}</span>
    </section>
  );
}

// A mark for each action, before its name on the card.
const ICONS: Readonly<Record<string, string>> = {
  "github.read": "◇",
  push: "↑",
  "github.open-pull-request": "⇄",
  "github.comment": "✎",
};

/** The GitHub Charm's actions as its card names them, each with the hub's rule for it. */
const GITHUB_RULES: ReadonlyArray<RuleInfo> = GITHUB_OPERATIONS.map((operation) => {
  const rule = RULES.find((r) => r.operation === operation);
  const words = messages.charms.github.actions[operation];
  return { ...rule, operation, label: words.label, note: words.note };
});
