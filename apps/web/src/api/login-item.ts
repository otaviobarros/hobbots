import type { LoginItemState } from "./client.ts";

/** What to tell the user about the login item, when macOS did not simply register it. */
export const loginItemNotice = (state: LoginItemState): { tone: "wait" | "problem"; text: string } | undefined => {
  if (state.status === "unavailable") {
    return { tone: "wait", text: "Only the installed Hobbots app can open at login." };
  }
  if (!state.openAtLogin) return undefined;
  if (state.status === "requires-approval") {
    return {
      tone: "wait",
      text: "macOS is waiting for you to allow Hobbots in System Settings › General › Login Items.",
    };
  }
  if (state.status !== "enabled") {
    return {
      tone: "problem",
      text: "macOS did not add Hobbots to your login items. Builds that are not signed can be refused: move Hobbots to Applications, open it from there and turn this on again.",
    };
  }
  return undefined;
};
