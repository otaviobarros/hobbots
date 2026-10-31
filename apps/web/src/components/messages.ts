/**
 * User-facing copy for the components in this folder, grouped by feature (STD-I18N-001). Copy moves
 * here from a component when that component next changes.
 */
export const messages = {
  models: {
    loading: "Asking Claude Code for its models",
    failed: "Hobbots could not get Claude Code's models.",
    retry: "Try again",
  },
  setup: {
    failed: "Hobbots could not read your setup.",
    retry: "Try again",
  },
  summon: {
    checkAgain: "Check again",
    checking: "Checking…",
  },
  home: {
    openChat: ({ name, role, state }: { name: string; role: string; state: string }) =>
      `Open chat with ${name}, ${role}, ${state}`,
    happeningNow: "Happening now",
    allQuiet: "All quiet. No hob is replying right now.",
  },
  enforcement: {
    heading: "Held on this hub",
    intro: ({ name }: { name: string }) =>
      `What ${name}'s runtime enforces on this hub, whatever ${name} is told. Anything it cannot hold is blocked.`,
    providerHeading: "Enforcement on this hub",
    listLabel: "Enforcement on this hub",
    capability: {
      toolInterception: "Tool calls checked first",
      processSandbox: "Process sandbox",
      hubTools: "Charms and coordination tools",
      toolEvents: "Tool steps reported",
      toolInterruption: "Running tools can be stopped",
    },
    status: { verified: "Verified", unverified: "Not verified", unsupported: "Unsupported" },
    needsSandbox: "Needs the sandbox",
    toolBlocked: "Blocked, because the sandbox cannot start on this hub.",
    toolChecked: ({ labels }: { labels: string }) => `${labels} is checked by Hobbots, not held by the sandbox.`,
    toolHeld: "Held by the sandbox.",
    toolHeldUnverified: "Held by the sandbox, not yet verified on this hub.",
    sandboxLabel: "Run in the sandbox",
    sandboxOn: ({ name }: { name: string }) =>
      `Commands, Git and the web run inside Hobbots' sandbox, which keeps ${name} in its folders.`,
    sandboxUnavailable: ({ name, evidence }: { name: string; evidence: string }) =>
      `The sandbox cannot start on this hub, so ${name}'s commands, local Git and the web are blocked. Why: ${evidence.replace(/\.?$/, ".")}`,
    ruleBlocked: "Blocked until the sandbox can start on this hub.",
  },
} as const;
