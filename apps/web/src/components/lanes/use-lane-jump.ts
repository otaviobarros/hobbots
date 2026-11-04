import type { AgentId } from "@hobbots/domain";
import { useState } from "react";
import { motionReduced } from "../../lib/motion.ts";
import { laneDomId } from "./lane-model.ts";

/**
 * Going to a hob's lane from the lineup: the lane scrolls into view and flashes once, and the
 * Workbench filters to the hob through `onPick`. With Reduce motion the lane is shown at once and
 * does not flash.
 */
export const useLaneJump = (onPick: (hobId: AgentId) => void) => {
  const [flashing, setFlashing] = useState<AgentId | null>(null);
  const jump = (hobId: AgentId) => {
    onPick(hobId);
    const reduced = motionReduced();
    document
      .getElementById(laneDomId(hobId))
      ?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest", inline: "center" });
    if (!reduced) setFlashing(hobId);
  };
  return { flashing, jump, flashed: () => setFlashing(null) };
};
