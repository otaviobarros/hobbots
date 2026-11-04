import type { SafetyPreset } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { PRESETS, presetInfo, type RuleAnswer } from "../../api/safety.ts";
import { setupQuery, useUpdateSetup } from "../../api/setup.ts";
import { FolderPicker, LockedSwitch } from "../safety/safety-and-folders.tsx";
import { StandingRuleSettings } from "../standing-rules/standing-rules.tsx";
import { messages } from "./messages.ts";
import { SettingsGroup } from "./settings-group.tsx";

const copy = messages.safety;

/** Each answer's mark and color in "With Balanced, your hobs:". */
const ANSWER_MARKS: Readonly<Record<RuleAnswer, { readonly glyph: string; readonly color: string }>> = {
  Allow: { glyph: "✓", color: "text-mint" },
  Ask: { glyph: "?", color: "text-lantern" },
  Never: { glyph: "✕", color: "text-rose" },
};

/**
 * Settings › Safety: how careful hobs are, the folders every hob can open, and what they are always
 * allowed to do. Every choice is stored on the hub at once.
 */
export function SafetySection() {
  const setup = useQuery(setupQuery);
  if (setup.isError) return <p className="m-0 text-sm text-rose">{copy.failed}</p>;
  if (!setup.data) return null;
  return (
    <>
      <SettingsGroup label={copy.howCareful}>
        <PresetChoice value={setup.data.safetyPreset} />
      </SettingsGroup>
      <SettingsGroup label={copy.folders}>
        <p className="m-0 text-sm text-text-secondary">{copy.foldersIntro}</p>
        {setup.data.approvedFolders.length === 0 && <p className="m-0 text-sm text-text-secondary">{copy.noFolders}</p>}
        <FolderPicker folders={setup.data.approvedFolders} look="settings" />
      </SettingsGroup>
      <StandingRuleSettings />
    </>
  );
}

/** Careful, Balanced or Trusting as three cards in one radio group, then what the chosen one means. */
function PresetChoice({ value }: { value: SafetyPreset }) {
  const update = useUpdateSetup();
  const name = useId();
  const shown = update.isPending && update.variables.safetyPreset ? update.variables.safetyPreset : value;
  const chosen = presetInfo(shown);
  return (
    <>
      <fieldset className="m-0 grid grid-cols-1 gap-2.5 border-0 p-0 sm:grid-cols-3">
        <legend className="sr-only">{copy.howCareful}</legend>
        {PRESETS.map((preset) => {
          const on = preset.id === shown;
          return (
            <label
              key={preset.id}
              className={cn(
                "flex cursor-pointer flex-col gap-1.5 rounded-card bg-card p-3.5 transition-colors duration-150 hover:bg-hover focus-ring-within",
                on && "ring-2 ring-focus-ring ring-inset",
              )}
            >
              <input
                type="radio"
                name={name}
                checked={on}
                disabled={update.isPending}
                onChange={() => update.mutate({ safetyPreset: preset.id })}
                className="sr-only"
              />
              <span className="flex items-center gap-2">
                <span className="flex-1 font-bold text-text-strong">{preset.label}</span>
                {preset.recommended && <Badge variant="done">{copy.suggested}</Badge>}
              </span>
              <span className="text-detail text-text-secondary">{preset.note}</span>
            </label>
          );
        })}
      </fieldset>
      <div className="flex flex-col gap-1 rounded-control bg-card px-3.5 py-3 text-sm">
        <span className="font-semibold text-text-strong">{copy.withPreset({ preset: chosen.label })}</span>
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {chosen.rules.map(([rule, answer]) => (
            <li key={rule} className="text-text">
              <span aria-hidden className={cn("inline-block w-5", ANSWER_MARKS[answer].color)}>
                {ANSWER_MARKS[answer].glyph}
              </span>
              {copy.answers[answer]({ rule })}
            </li>
          ))}
        </ul>
      </div>
      {shown === "trusting" && (
        <LockedSwitch
          label={copy.unsandboxed.label}
          note={copy.unsandboxed.note}
          checked={false}
          later={copy.unsandboxed.later}
        />
      )}
      {update.isError && (
        <p role="alert" className="m-0 text-sm text-rose">
          {copy.saveFailed}
        </p>
      )}
    </>
  );
}
