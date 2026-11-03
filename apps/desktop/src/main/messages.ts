/** User-facing copy for the desktop app's main process, grouped by feature (STD-I18N-001). */
export const messages = {
  requestNotice: {
    title: ({ name }: { name: string }) => `${name} asks permission`,
    unknownHob: "A hob",
  },
  deviceNotice: {
    title: ({ name }: { name: string }) => `${name} wants to use Hobbots`,
    body: ({ code }: { code: string }) => `Check that it shows ${code}, then Allow or Deny.`,
  },
  remoteAccess: {
    pause: "Pause remote access",
    pauseHint: "Your other devices can open Hobbots",
    resume: "Resume remote access",
    resumeHint: "Paused · only this computer can open Hobbots",
    couldNotPause: "Hobbots could not pause remote access",
    couldNotResume: "Hobbots could not resume remote access",
    checkServer: "Check that the server is running, then try again.",
    ok: "OK",
  },
  connection: {
    connected: ({ hub }: { hub: string }) => `Connected to ${hub}`,
    connecting: ({ hub }: { hub: string }) => `Connecting to ${hub}…`,
    noToken: ({ hub }: { hub: string }) => `This Mac is not connected to ${hub}`,
    noTokenDetail: ({ hub }: { hub: string }) => `Ask ${hub} again to connect.`,
    otherNode: ({ address }: { address: string }) => `${address} is now a different computer.`,
    unreachable: ({ hub }: { hub: string }) => `Hobbots on ${hub} isn't answering.`,
    unreachableDetail: "It may be asleep, closed, or off Tailscale. Hobbots tries again.",
    notHobbots: ({ address }: { address: string }) => `Something other than Hobbots answers at ${address}.`,
    hubOlder: ({ hub, version }: { hub: string; version: string }) => `${hub} runs an older Hobbots (${version}).`,
    hubOlderDetail: ({ hub }: { hub: string }) => `Update Hobbots on ${hub} to connect.`,
    appOlder: ({ hub }: { hub: string }) => `This Mac's Hobbots is too old for ${hub}.`,
    appOlderDetail: "Update Hobbots on this Mac.",
    revoked: ({ hub }: { hub: string }) => `This Mac was removed from ${hub}.`,
    unknownDevice: ({ hub }: { hub: string }) => `${hub} no longer knows this Mac.`,
    askAgainDetail: ({ hub }: { hub: string }) => `Ask ${hub} again, or disconnect.`,
    ok: "OK",
  },
  disconnect: {
    stillListed: ({ hub }: { hub: string }) => `Disconnected from ${hub}`,
    stillListedDetail: ({ hub }: { hub: string }) =>
      `Hobbots could not reach ${hub}, so it still lists this Mac. Revoke it there, in Settings › Devices.`,
    ok: "OK",
  },
  choose: {
    title: "This Mac is not connected to a hub",
    detail:
      "Hobbots here was disconnected from its hub. Run Hobbots on this Mac to make it the hub, where hobs live and work, or quit.",
    runHere: "Run Hobbots on this Mac",
    quit: "Quit",
  },
} as const;
