import type { NotKept } from "@hobbots/domain";
import { messages } from "./messages.ts";

/** Why one version of a file is not shown, in its place (ADR 023). */
export function NotKeptNote({ side, reason }: { side: "before" | "after"; reason: NotKept }) {
  return <p className="m-0 bg-notice px-3 py-2 text-detail text-secondary-text">{messages.notKept[side][reason]}</p>;
}
