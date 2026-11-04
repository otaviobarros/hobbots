import { Button } from "@hobbots/ui/components/button";
import { Switch } from "@hobbots/ui/components/switch";
import { useId } from "react";
import { choiceFor, setMotionChoice, useMotion } from "../../lib/motion.ts";
import { messages } from "./messages.ts";

const copy = messages.motion;

/** Settings › This app: Reduce motion on this device, following the system until it is changed. */
export function ReduceMotionRow() {
  const labelId = useId();
  const noteId = useId();
  const motion = useMotion();
  const followsSystem = motion.choice === "system";
  const note = followsSystem ? copy.followsSystem : motion.systemReduces ? copy.setHereSystemOn : copy.setHereSystemOff;

  return (
    <div className="flex items-center gap-4 border-b-2 border-line py-2.5">
      <Switch
        aria-labelledby={labelId}
        aria-describedby={noteId}
        checked={motion.reduced}
        onCheckedChange={(on) => setMotionChoice(choiceFor(on, motion.systemReduces))}
      />
      <div className="flex flex-1 flex-col gap-0.5">
        <span id={labelId} className="font-bold">
          {copy.label}
        </span>
        <span id={noteId} className="text-[13px] text-text-secondary">
          {note}
        </span>
      </div>
      {!followsSystem && (
        <Button variant="ghost" size="sm" onClick={() => setMotionChoice("system")}>
          {copy.useSystem}
        </Button>
      )}
    </div>
  );
}
