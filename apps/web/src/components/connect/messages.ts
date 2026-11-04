import { formatCount, plural } from "../../lib/format.ts";

const seconds = (count: number) =>
  plural(count, { one: `${formatCount(count)} second`, other: `${formatCount(count)} seconds` });

/** User-facing copy for Connect, setup's way to use a hub on another computer (screen 2, ADR 025) (STD-I18N-001). */
export const messages = {
  stage: "Another computer",
  /** Setup's local pages opened anywhere but the desktop app's own window. */
  noBridge: "Open the Hobbots app to set it up.",
  elder: {
    connect: "Visiting a hub? Tell me its address and I will knock on the door.",
    waiting: ({ computer }: { computer: string }) =>
      `I knocked! Someone at ${computer} needs to let us in. Check that the code matches.`,
    allowed: ({ computer }: { computer: string }) => `We are in. Everything you see next is served from ${computer}.`,
    denied: ({ computer }: { computer: string }) => `The door stayed shut. Ask whoever uses ${computer} to try again.`,
    ended: "Something got in the way. Here is what I found.",
    starting: "Lighting the lanterns. Your hub is getting ready on this computer.",
  },

  form: {
    title: "Connect to your hub",
    intro: "Type the hub's address from its Settings › Devices, or pick a hub found on your tailnet.",
    addressLabel: "Address",
    placeholder: "studio or http://studio:4317",
    found: "Found on your tailnet",
    looking: "Looking for hubs on your tailnet…",
    lookAgain: "Look again",
    none: "No hubs found on your tailnet yet.",
    notListed:
      "Not listed? Check that Tailscale is on here and on the hub, and that the hub lets other devices connect in its Settings › Devices.",
    use: "Connect",
    connectLabel: ({ computer }: { computer: string }) => `Connect to ${computer}`,
    calledItself: ({ name }: { name: string }) => `calls itself “${name}”`,
    version: ({ version }: { version: string }) => `Hobbots ${version}`,
    hubOlder: ({ computer }: { computer: string }) => `${computer} runs an older Hobbots. Update it there to connect.`,
    appOlder: ({ computer }: { computer: string }) =>
      `This computer's Hobbots is too old for ${computer}. Update Hobbots here.`,
    scanFailed: "Hobbots could not look for hubs. Try again in a moment.",
  },

  /** Why a typed address was refused before Hobbots sent anything. */
  refused: {
    Empty: "Type the hub's address, or pick a hub found on your tailnet.",
    Malformed: "That isn't an address Hobbots can use. Type the hub's name, such as studio, or its http:// address.",
    TailscaleNotReady: {
      notInstalled: "Tailscale isn't on this computer yet. Hobbots connects to your hub through it.",
      notRunning: "Tailscale is off on this computer. Turn it on to reach your hub.",
      signedOut: "Tailscale is signed out on this computer. Sign in to reach your hub.",
    },
    Loopback: "That address is this computer. Type the address of the computer your hub runs on.",
    ThisComputer: "That's this computer. Type the address of the computer your hub runs on.",
    LocalNetwork: "Hobbots connects through Tailscale only. Type the hub's Tailscale name instead of a local address.",
    Public: "Hobbots connects through Tailscale only, never over the internet. Type the hub's Tailscale name.",
    NotOnTailnet: "Tailscale doesn't know a computer by that name. Check the address in the hub's Settings › Devices.",
    NotYours: ({ computer }: { computer: string }) =>
      `${computer} isn't one of your own computers on Tailscale. Hobbots connects only to computers signed in to your account.`,
  },

  connecting: "Connecting…",
  connect: "Connect",
  back: "Back",
  cancel: "Cancel",
  hint: "Type an address or pick a hub",

  waiting: {
    title: ({ computer }: { computer: string }) => `Waiting for ${computer} to let you in`,
    intro: ({ computer }: { computer: string }) =>
      `Approve this computer on ${computer}. You should see a prompt with this code there.`,
    codeLabel: "Matching code",
    knocking: "Knocking on the door",
    who: ({ computer, owner }: { computer: string; owner: string | null }) =>
      owner === null ? `${computer} on your tailnet` : `${computer} on your tailnet, signed in as ${owner}`,
    expires: ({ time }: { time: string }) => `The request lasts until ${time}.`,
    warning: ({ computer }: { computer: string }) =>
      `If Hobbots opens here before you chose Allow on ${computer}, something else answered. Disconnect in Settings › Devices.`,
  },

  allowed: {
    title: "You're in!",
    body: ({ computer }: { computer: string }) =>
      `This computer now uses Hobbots on ${computer}. Hobs, chats and quests live there and keep working while this one sleeps. Opening Home…`,
  },

  /** How a request that did not connect ended. */
  ended: {
    denied: {
      title: ({ computer }: { computer: string }) => `${computer} said no`,
      body: ({ computer }: { computer: string }) =>
        `This computer wasn't allowed. If that was a mistake, ask again and choose Allow on ${computer}.`,
    },
    expired: {
      title: "This request ran out of time",
      body: "Nobody answered it in time. Ask again to get a new code.",
    },
    throttled: {
      title: "Too many requests",
      body: ({ count, computer }: { count: number; computer: string }) =>
        `Wait ${seconds(count)} before asking again. Requests still waiting can be answered in Settings › Devices on ${computer}.`,
    },
    full: {
      title: ({ computer }: { computer: string }) => `${computer} has too many requests waiting`,
      body: ({ computer }: { computer: string }) =>
        `Answer or clear them in Settings › Devices on ${computer}, then ask again.`,
    },
    notYours: {
      title: "Only your own computers can connect",
      body: ({ computer }: { computer: string }) =>
        `${computer} refused this computer because it isn't signed in to the same Tailscale account. Sign in to that account here, then ask again.`,
    },
    refused: {
      title: ({ computer }: { computer: string }) => `${computer} turned the request away`,
      body: "Check the hub's Settings › Devices, then ask again.",
    },
    notHobbots: {
      title: ({ address }: { address: string }) => `Something other than Hobbots answers at ${address}`,
      body: "Check the address in the hub's Settings › Devices.",
    },
    noAnswer: {
      title: ({ computer }: { computer: string }) => `Hobbots on ${computer} isn't answering`,
      body: ({ computer }: { computer: string }) =>
        `It may be closed or asleep, it may not let other devices connect, or its port changed. Check Settings › Devices on ${computer}.`,
    },
    hubOlder: {
      title: ({ computer, version }: { computer: string; version: string }) =>
        `${computer} runs an older Hobbots (${version})`,
      body: ({ computer }: { computer: string }) => `Update Hobbots on ${computer} to connect.`,
    },
    appOlder: {
      title: ({ computer }: { computer: string }) => `This computer's Hobbots is too old for ${computer}`,
      body: "Update Hobbots on this computer to connect.",
    },
    otherNode: {
      title: ({ address }: { address: string }) => `${address} is now a different computer`,
      body: "Hobbots sent it nothing. Check the hub's address in its Settings › Devices.",
    },
    noKeychain: {
      title: "Hobbots couldn't keep this computer's key",
      body: ({ reason }: { reason: string }) =>
        `The keychain refused it (${reason}). Hobbots never writes the key to a file, so it can't connect without the keychain.`,
    },
    askAgain: "Ask again",
  },
};
