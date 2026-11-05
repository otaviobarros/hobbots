import type { SafetyPreset } from "@hobbots/domain";
import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import { presetInfo } from "../../api/safety.ts";
import { SettingsGroup } from "../settings/settings-group.tsx";
import { messages } from "./messages.ts";
import { shareAnswer } from "./model.ts";

const copy = messages.shares;

/**
 * Settings › Safety › What hobs learn (ADR 028): how a hob's share reaches the others under the
 * chosen preset. The preset decides it, so each row shows its answer and changes with the preset;
 * About you asks under every preset.
 */
export function MemoryShares({ preset }: { preset: SafetyPreset | undefined }) {
  return (
    <SettingsGroup label={copy.label}>
      <p className="m-0 text-ui text-text-secondary">{copy.intro}</p>
      {(["project", "everyone"] as const).map((scope) => {
        const answer = preset === undefined ? null : shareAnswer(preset, scope);
        return (
          <div key={scope} className="flex flex-wrap items-center gap-3 rounded-control bg-card px-3.5 py-2.5">
            <span className="flex min-w-0 flex-1 flex-col">
              <span>{copy.rows[scope].title}</span>
              <span className="text-detail text-text-secondary">{copy.rows[scope].detail}</span>
            </span>
            <SegmentedControl size="sm" aria-label={copy.rows[scope].title} value={answer} onValueChange={() => {}}>
              {(["ask", "through"] as const).map((value) => (
                <SegmentedControlItem
                  key={value}
                  value={value}
                  disabled={value !== answer}
                  title={
                    scope === "everyone" && value === "through"
                      ? copy.alwaysAsks
                      : preset === undefined
                        ? copy[value]
                        : copy.follows({ preset: presetInfo(preset).label })
                  }
                >
                  {copy[value]}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          </div>
        );
      })}
      {preset !== undefined && (
        <p className="m-0 text-detail text-label">{copy.follows({ preset: presetInfo(preset).label })}</p>
      )}
    </SettingsGroup>
  );
}
