import type { WaitingDevice } from "@hobbots/api";
import { messages } from "./messages.ts";

const copy = messages.prompt;

/** The matching code as both screens show it: two groups of three digits, "482 913" (ADR 021). */
export const groupedCode = (code: string): string =>
  code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;

/**
 * Where a waiting device asked from, in the prompt's words: "From this computer" for the hub
 * itself, else its Tailscale node and owner, or the tags a tagged node carries.
 */
export const askedFrom = (device: WaitingDevice): string => {
  const node = device.request.tailscale;
  if (device.fromHub || node === null) return copy.fromHub;
  const owner = node.owner._tag === "User" ? node.owner.login : copy.tagged({ tags: node.owner.tags.join(", ") });
  return copy.owner({ node: node.nodeName.split(".")[0] ?? node.nodeName, owner });
};

/** What the device uses, in the prompt's words: the Hobbots app or a browser, and its platform. */
export const usingText = (device: WaitingDevice): string => {
  const what = copy.using[device.request.kind];
  return device.request.platform === "" ? what : `${what} · ${device.request.platform}`;
};
