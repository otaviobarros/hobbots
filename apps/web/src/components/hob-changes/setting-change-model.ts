import type { AnyOperation, SettingChange, SettingDiff, SummoningForEveryHob } from "@hobbots/domain";
import { presetInfo } from "../../api/safety.ts";
import { operationLabel } from "../../lib/reply-steps.ts";
import type { FieldDiff } from "./hob-changes-model.ts";
import { messages } from "./messages.ts";

const copy = messages.settings;
const values = messages.values;

/** One part of a setting a change moved, shown as a version's field is. */
export type SettingLines = Omit<FieldDiff, "key">;

/** What a change did to its setting: turned "Summoning for every hob" on or off, or changed a value. */
type SettingMove = "on" | "off" | "changed";

const settingMove = (diff: SettingDiff): SettingMove => {
  if (diff.setting !== "summoningForEveryHob") return "changed";
  if (diff.before === null) return "on";
  return diff.after === null ? "off" : "changed";
};

/** The setting's name, as Settings shows it. */
export const settingName = (diff: SettingDiff): string => copy.names[diff.setting];

/** The change's title in Settings › Changes, such as "Summoning for every hob turned on". */
export const settingTitle = (diff: SettingDiff): string => {
  const setting = settingName(diff);
  const move = settingMove(diff);
  return move === "on"
    ? copy.turnedOn({ setting })
    : move === "off"
      ? copy.turnedOff({ setting })
      : copy.changed({ setting });
};

/** What the change did to one hob it reached, for that hob's History. */
export const settingReachLine = (diff: SettingDiff, name: string): string => {
  const move = settingMove(diff);
  if (diff.setting === "summoningForEveryHob") {
    return move === "on" ? copy.gave({ name }) : move === "off" ? copy.tookAway({ name }) : copy.changedFor({ name });
  }
  return diff.setting === "safetyPreset" ? copy.presetFor({ name }) : copy.foldersFor({ name });
};

const yesNo = (on: boolean) => (on ? values.yes : values.no);

const scopeText = (everyHob: SummoningForEveryHob | null, nameOf: (id: string) => string) =>
  everyHob === null
    ? ""
    : [
        values.scopeSummoned({ answer: yesNo(everyHob.scope.summoned) }),
        values.scopeSelf({ answer: yesNo(everyHob.scope.self) }),
        ...everyHob.scope.hobs.map((id) => values.scopePicked({ hob: nameOf(id) })),
      ].join("\n");

const answersText = (everyHob: SummoningForEveryHob | null) =>
  everyHob === null
    ? ""
    : Object.entries(everyHob.overrides)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([operation, answer]) =>
          values.rule({
            operation: operationLabel(operation as AnyOperation),
            answer: values.answers[answer] ?? answer,
          }),
        )
        .join("\n");

const part = (label: string, before: string, after: string, lines: boolean): ReadonlyArray<SettingLines> =>
  before === after ? [] : [{ label, before, after, lines }];

/** What the change moved, part by part, with each part before and after; `nameOf` names a picked hob. */
export const settingLines = (
  diff: SettingDiff,
  nameOf: (id: string) => string = () => messages.someHob,
): ReadonlyArray<SettingLines> => {
  switch (diff.setting) {
    case "safetyPreset":
      return part(copy.parts.preset, presetInfo(diff.before).label, presetInfo(diff.after).label, false);
    case "approvedFolders":
      return part(copy.parts.folders, diff.before.join("\n"), diff.after.join("\n"), true);
    case "summoningForEveryHob":
      return [
        ...part(
          copy.parts.state,
          diff.before === null ? copy.off : copy.on,
          diff.after === null ? copy.off : copy.on,
          false,
        ),
        ...part(copy.parts.scope, scopeText(diff.before, nameOf), scopeText(diff.after, nameOf), true),
        ...part(copy.parts.answers, answersText(diff.before), answersText(diff.after), true),
      ];
  }
};

/** Who made a setting change: a person, or the hub itself, as when it respells the shared folders. */
export const settingMakerLine = (change: SettingChange): string =>
  change.actor.kind === "hub" ? copy.byHub : messages.row.byYou;
