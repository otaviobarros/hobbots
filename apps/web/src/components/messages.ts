/**
 * User-facing copy for the components in this folder, grouped by feature (STD-I18N-001). Copy moves
 * here from a component when that component next changes.
 */
/** Evidence from the hub as a sentence, ending with one period. */
const sentence = (text: string) => text.replace(/\.?$/, ".");

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
  reply: {
    thinking: ({ name }: { name: string }) => `${name} is thinking`,
    stopping: "Stopping this reply…",
    stopped: ({ name }: { name: string }) => `■ You stopped this reply. ${name} kept what it wrote so far.`,
    interrupted: ({ name }: { name: string }) =>
      `This reply was cut off, not by you: Hobbots restarted or ${name} was paused. What it wrote so far is kept.`,
    cutOff: ({ error }: { error: string }) => `Answer cut off: ${error}. Nothing was lost before this point.`,
    limited: ({ name, refill }: { name: string; refill: string }) =>
      `⚗ ${name} used up the Claude allowance for now. ${refill} What it wrote so far is kept.`,
    resuming: ({ name }: { name: string }) => `Picking up where ${name} left off…`,
    continue: "Continue from here",
    failed: ({ error }: { error: string | null }) =>
      `✗ This reply failed: ${error ?? "unknown error"}. Send your message again to retry.`,
  },
  queued: {
    label: "Queued message",
    waitsForWake: ({ name }: { name: string }) => `◷ Queued. Waits until you wake ${name}.`,
    readsNext: ({ name }: { name: string }) => `◷ Queued. ${name} reads it after this reply.`,
    remove: "Remove",
    sendNow: "Send now",
    sendNowAndInterrupt: "Send now and interrupt",
  },
  steps: {
    list: "Reply steps",
    /** What a screen reader hears after each step's words. */
    outcome: {
      running: "in progress",
      awaiting: "waiting for your approval",
      done: "done",
      failed: "failed",
      denied: "not allowed",
      unfinished: "did not finish",
    },
    running: ({ label }: { label: string }) => `${label}…`,
    awaiting: "Waiting for your approval.",
    failed: "The tool reported an error.",
    unfinished: "The reply ended before this step finished.",
    deniedByPolicy: ({ reason }: { reason: string }) => `Not allowed by the hob's permissions: ${reason}`,
    deniedBySandbox: ({ reason }: { reason: string }) => `Blocked by the sandbox: ${reason}`,
    deniedByUser: ({ reason }: { reason: string }) => `You denied this: ${reason}`,
    tool: "Tool",
    operation: "Action",
    targets: "On",
    noTargets: "Nothing in particular",
  },
  approval: {
    asks: ({ name }: { name: string }) => `${name} asks permission`,
    expires: "Expires if this reply stops or Hobbots restarts.",
    action: "Action",
    target: "On",
    noTarget: "Nothing in particular",
    askedBy: "Asked by",
    chain: ({ name }: { name: string }) => `You → ${name}`,
    why: "Why now",
    risk: "Risk",
    allowOnce: "Allow once",
    deny: "Deny",
    reasonLabel: ({ name }: { name: string }) => `Tell ${name} why (optional)`,
    confirmDeny: "Deny",
    cancel: "Cancel",
    sending: "Sending your decision…",
    approved: ({ name }: { name: string }) => `✓ Allowed once. ${name} carries on.`,
    denied: ({ name }: { name: string }) => `✕ Denied. ${name} was told it may not.`,
    deniedWithReason: ({ name, reason }: { name: string; reason: string }) =>
      `✕ Denied: “${reason}”. ${name} was told why.`,
    expired: "◷ Expired before anyone decided. Nothing ran.",
    closed: "This request was already decided or has expired.",
    changed: "This action changed since it was shown. Check it again.",
    failed: "Hobbots could not send your decision. Try again.",
    /** What could go wrong if the action runs, by operation. */
    riskOf: {
      "read-files": "Reads only. Nothing changes.",
      "edit-files": "Changes files in its folders.",
      "delete-files": "Removes files. They may not come back.",
      "run-commands": "A command can change or remove files in its folder.",
      "local-git": "Changes the Git history in its folder.",
      push: "Sends commits to a remote, where others can see them.",
      "use-web": "Reaches a site outside this hub.",
      "outside-folders": "Acts outside the folders this hob may use.",
    },
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
    toolBlocked: {
      unsupported: "Blocked, because the sandbox cannot start on this hub.",
      unverified: "Blocked, because the sandbox is not yet verified on this hub.",
    },
    toolChecked: ({ labels }: { labels: string }) => `${labels} is checked by Hobbots, not held by the sandbox.`,
    toolHeld: "Held by the sandbox.",
    sandboxLabel: "Run in the sandbox",
    sandboxOn: ({ name }: { name: string }) =>
      `Commands, Git and the web run inside Hobbots' sandbox, which keeps ${name} in its folders.`,
    sandboxMissing: {
      unsupported: ({ name, evidence }: { name: string; evidence: string }) =>
        `The sandbox cannot start on this hub, so ${name}'s commands, local Git and the web are blocked. Why: ${sentence(evidence)}`,
      unverified: ({ name, evidence }: { name: string; evidence: string }) =>
        `The sandbox is not yet verified on this hub, so ${name}'s commands, local Git and the web are blocked until it is. Why: ${sentence(evidence)}`,
    },
    ruleBlocked: {
      unsupported: "Blocked until the sandbox can start on this hub.",
      unverified: "Blocked until the sandbox is verified on this hub.",
    },
  },
} as const;
