import type { ChangeReach } from "@hobbots/api";
import { RUNTIME_NAMES, type RuntimeKind } from "@hobbots/domain";
import { RULES } from "../../api/safety.ts";
import { formatList } from "../../lib/format.ts";
import { charmName } from "../charm-name.ts";
import { messages } from "../messages.ts";

const copy = messages.permissions.reach;

/**
 * What a change opens that some of the hob's sessions still do not get, and why (#1347): the
 * Charms whose writes a Task session is not offered, and on a runtime whose resumed session keeps
 * the tools it started with, what only a chat or Task started after the change gets. None when the
 * change reaches every session.
 */
export const reachLines = (
  hob: { readonly name: string; readonly runtime: RuntimeKind },
  reach: ChangeReach | undefined,
): ReadonlyArray<string> => {
  if (reach === undefined) return [];
  const { charms, operations } = reach.newSessionsOnly;
  const labels = operations.map((operation) => RULES.find((rule) => rule.operation === operation)?.label ?? operation);
  const what = [
    ...charms.map((charm) => copy.charmTools({ charm: charmName(charm) })),
    ...(labels.length === 0 ? [] : [copy.answerTools({ answers: formatList(labels) })]),
  ];
  return [
    ...reach.chatsOnly.map((charm) => copy.chatsOnly({ name: hob.name, charm: charmName(charm) })),
    ...(what.length === 0
      ? []
      : [copy.newSessionsOnly({ name: hob.name, runtime: RUNTIME_NAMES[hob.runtime], what: formatList(what) })]),
  ];
};
