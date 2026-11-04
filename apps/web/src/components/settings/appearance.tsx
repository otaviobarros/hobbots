import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import { cn } from "@hobbots/ui/lib/utils";
import { type ReactNode, useId } from "react";
import { setTextSize, TEXT_SIZES, type TextSize, useTextSize } from "../../lib/text-size.ts";
import { type Look, lookOf, type Mode, modeOf, setTheme, themeOf, useTheme } from "../../lib/theme.ts";
import { messages } from "./messages.ts";
import { SettingsGroup } from "./settings-group.tsx";

const copy = messages.appearance;

const LOOKS: ReadonlyArray<Look> = ["lamplight", "workshop"];
const MODES: ReadonlyArray<Mode> = ["dark", "light"];

/** Each look's preview: its own ground, bar and mark, rounded in Lamplight and square in Workshop. */
const PREVIEW: Readonly<Record<Look, { readonly ground: string; readonly bar: string; readonly mark: string }>> = {
  lamplight: {
    ground: "rounded-[8px] bg-look-lamplight-ground",
    bar: "rounded-[8px] bg-look-lamplight-bar",
    mark: "rounded-[8px] bg-look-lamplight-mark",
  },
  workshop: {
    ground: "rounded-none bg-look-workshop-ground",
    bar: "rounded-none bg-look-workshop-bar",
    mark: "rounded-none bg-look-workshop-mark",
  },
};

/**
 * Settings › This app › Appearance: the look (Lamplight or Workshop), Dark or Light, and the text
 * size. Each is picked by hand and kept on this device.
 */
export function AppearanceGroup() {
  const theme = useTheme();
  const look = lookOf(theme);
  const mode = modeOf(theme);
  const textSize = useTextSize();
  const name = useId();
  return (
    <SettingsGroup label={copy.heading}>
      <fieldset className="m-0 grid grid-cols-1 gap-2.5 border-0 p-0 sm:grid-cols-2">
        <legend className="sr-only">{copy.look}</legend>
        {LOOKS.map((option) => {
          const on = option === look;
          const preview = PREVIEW[option];
          return (
            <label
              key={option}
              className={cn(
                "flex cursor-pointer flex-col gap-2.5 rounded-card bg-card p-3 transition-colors duration-150 hover:bg-hover has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus-ring",
                on && "ring-2 ring-focus-ring ring-inset",
              )}
            >
              <input
                type="radio"
                name={name}
                checked={on}
                onChange={() => setTheme(themeOf(option, mode))}
                className="sr-only"
              />
              <span aria-hidden className={cn("flex h-[72px] items-end gap-1.5 p-2", preview.ground)}>
                <span className={cn("size-7", preview.mark)} />
                <span className={cn("h-2.5 flex-1", preview.bar)} />
              </span>
              <span className="flex flex-col">
                <span className="font-semibold text-text-strong">{copy.looks[option].label}</span>
                <span className="text-detail text-text-secondary">{copy.looks[option].hint}</span>
              </span>
            </label>
          );
        })}
      </fieldset>
      <Choice label={copy.mode}>
        <SegmentedControl<Mode>
          aria-label={copy.mode}
          value={mode}
          onValueChange={(next) => setTheme(themeOf(look, next))}
        >
          {MODES.map((option) => (
            <SegmentedControlItem key={option} value={option} className="flex-1">
              {copy.modes[option]}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </Choice>
      <Choice label={copy.textSize}>
        <SegmentedControl<TextSize> aria-label={copy.textSize} value={textSize} onValueChange={setTextSize}>
          {TEXT_SIZES.map((option) => (
            <SegmentedControlItem key={option} value={option} className="flex-1">
              {copy.sizes[option]}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </Choice>
    </SettingsGroup>
  );
}

/** A label on the left and its segmented control, as wide as the design's. */
function Choice({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      <span aria-hidden className="w-[120px] text-text-secondary">
        {label}
      </span>
      <div className="w-full max-w-[300px] *:w-full">{children}</div>
    </div>
  );
}
