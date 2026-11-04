import { formatCount, plural } from "../../lib/format.ts";

const seconds = (count: number) =>
  plural(count, { one: `${formatCount(count)} second`, other: `${formatCount(count)} seconds` });

/** User-facing copy for pairing a new device (screen 4, ADR 021) (STD-I18N-001). */
export const messages = {
  /** A browser's suggested name before the user changes it: "Safari on iPhone". */
  suggestedName: ({ browser, platform }: { browser: string | undefined; platform: string | undefined }) => {
    const what = browser ?? "Browser";
    return platform === undefined ? what : `${what} on ${platform}`;
  },
  thisHub: "this computer",

  // The new device's own screen.
  ask: {
    title: ({ hub }: { hub: string }) => `Use Hobbots on ${hub}`,
    intro:
      "This device isn't allowed yet. Ask once, then allow it on the computer that runs Hobbots. It's remembered after that.",
    nameLabel: "Name this device",
    nameHint: "You'll see this name on the hub, and in Settings › Devices.",
    submit: "Ask for access",
    asking: "Asking…",
    failed: "Hobbots didn't answer. Check that it is running, then ask again.",
  },
  waiting: {
    title: ({ hub }: { hub: string }) => `Waiting for approval on ${hub}`,
    intro: ({ hub }: { hub: string }) =>
      `On ${hub}, check that the prompt shows this code, then choose Allow. This page opens Hobbots by itself.`,
    codeLabel: "Matching code",
    expires: ({ time }: { time: string }) => `The request lasts until ${time}.`,
  },
  denied: {
    title: ({ hub }: { hub: string }) => `Not allowed on ${hub}`,
    intro: "This device was turned away. You can ask again in a minute.",
  },
  expired: {
    title: "This request ran out of time",
    intro: "Nobody answered it in time. Ask again to get a new code.",
  },
  throttled: {
    title: "Too many requests",
    intro: ({ count }: { count: number }) =>
      `Wait ${seconds(count)} before asking again. Requests still waiting can be answered in Settings › Devices on the hub.`,
  },
  notYours: {
    title: "Only your own devices can ask",
    intro:
      "This device belongs to another Tailscale account, or to none. Sign it in to the account Hobbots runs under, then ask again.",
  },
  allowed: "Allowed. Opening Hobbots…",
  askAgain: "Ask again",

  // The prompt on the hub, Needs you and Settings › Devices.
  prompt: {
    kicker: "New device",
    title: ({ name }: { name: string }) => `${name} wants to use Hobbots`,
    label: ({ name }: { name: string }) => `${name} asks to use Hobbots`,
    facts: { device: "Device", using: "Using", tailscale: "Tailscale", asked: "Asked" },
    using: { browser: "A browser", desktop: "The Hobbots app" },
    fromHub: "From this computer",
    owner: ({ node, owner }: { node: string; owner: string }) => `${node} · ${owner}`,
    tagged: ({ tags }: { tags: string }) => `tagged ${tags}`,
    matchLabel: "Matching code",
    matchHint: ({ name }: { name: string }) => `Check that ${name} shows the same code.`,
    grants:
      "An allowed device gets all of Hobbots: chat, Quests, approvals and the Workbench. Hobs keep working only on this computer.",
    allow: "Allow",
    deny: "Deny",
    later: "Decide later",
    failed: "That didn't go through. It may have been answered elsewhere, or run out of time.",
    allowedTitle: ({ name }: { name: string }) => `${name} can use Hobbots now`,
    allowedIntro: "It's remembered, so it won't ask again. Revoke it any time in Settings › Devices.",
    deniedTitle: ({ name }: { name: string }) => `${name} was turned away`,
    deniedIntro: "It can't see anything. If it asks again, you'll get a new prompt.",
    done: "Done",
  },
  settings: {
    heading: "Waiting to be allowed",
    deferred: "Decided later",
    expires: ({ time }: { time: string }) => `Waits until ${time}`,
  },
} as const;
