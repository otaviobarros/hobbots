import { Button } from "@hobbots/ui/components/button";
import { Switch } from "@hobbots/ui/components/switch";
import { useId } from "react";
import { choiceFor, setMotionChoice, useMotion } from "../../lib/motion.ts";

/** Settings › This app: Reduce motion on this device, following the system until it is changed. */
export function ReduceMotionRow() {
  const labelId = useId();
  const noteId = useId();
  const motion = useMotion();
  const followsSystem = motion.choice === "system";

  return (
    <div className="flex items-center gap-4 border-b-2 border-line py-2.5">
      <div className="flex flex-1 flex-col gap-0.5">
        <span id={labelId} className="font-bold">
          Reduce motion
        </span>
        <span id={noteId} className="text-[13px] text-secondary-text">
          Fewer animations. Hobs stand still instead of hopping.{" "}
          {followsSystem
            ? "Follows your system setting on this device."
            : `Set on this device. Your system setting is ${motion.systemReduces ? "on" : "off"}.`}
        </span>
      </div>
      {!followsSystem && (
        <Button variant="ghost" size="sm" onClick={() => setMotionChoice("system")}>
          Use the system setting
        </Button>
      )}
      <Switch
        aria-labelledby={labelId}
        aria-describedby={noteId}
        checked={motion.reduced}
        onCheckedChange={(on) => setMotionChoice(choiceFor(on, motion.systemReduces))}
      />
    </div>
  );
}
