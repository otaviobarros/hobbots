import type { ChangeReach } from "@hobbots/api";
import { type AnyOperation, RUNTIME_NAMES } from "@hobbots/domain";
import { RULES } from "../../api/safety.ts";
import { formatList } from "../../lib/format.ts";
import { charmName } from "../charm-name.ts";
import { messages } from "../messages.ts";

const copy = messages.permissions.reach;

const labelOf = (operation: AnyOperation) => RULES.find((rule) => rule.operation === operation)?.label ?? operation;

/**
 * What a change opens that some of the hob's sessions still do not get, and why (#1347): the
 * Charms whose writes a Task session is not offered, and, on a runtime whose resumed session keeps
 * the tools it started with, what only a chat or Task started after the change gets. None when the
 * change reaches every session.
 */
export const reachLines = (hob: { readonly name: string }, reach: ChangeReach | undefined): ReadonlyArray<string> => {
  if (reach === undefined) return [];
  const { runtimes, charms, operations, taskOperations } = reach.newSessionsOnly;
  const runtime = formatList(runtimes.map((each) => RUNTIME_NAMES[each]));
  const everywhere = [
    ...charms.map((charm) => copy.charmTools({ charm: charmName(charm) })),
    ...(operations.length === 0 ? [] : [copy.answerTools({ answers: formatList(operations.map(labelOf)) })]),
  ];
  return [
    ...reach.chatsOnly.map((charm) => copy.chatsOnly({ name: hob.name, charm: charmName(charm) })),
    ...(everywhere.length === 0
      ? []
      : [copy.newSessionsOnly({ name: hob.name, runtime, what: formatList(everywhere) })]),
    ...(taskOperations.length === 0
      ? []
      : [
          copy.newTasksOnly({
            name: hob.name,
            runtime,
            what: copy.answerTools({ answers: formatList(taskOperations.map(labelOf)) }),
          }),
        ]),
  ];
};
