import { formatCount, plural as pluralForm } from "../lib/format.ts";

/**
 * User-facing copy for the components in this folder, grouped by feature (STD-I18N-001). Copy moves
 * here from a component when that component next changes.
 */
/** Evidence from the hub as a sentence, ending with one period. */
const sentence = (text: string) => text.replace(/\.?$/, ".");

const plural = new Intl.PluralRules("en");

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
  chief: {
    home: "Hobbots home",
    working: "Hobbots home, hobs are working",
    needsYou: ({ count }: { count: number }) =>
      pluralForm(count, {
        one: "Hobbots inbox, a request needs you",
        other: `Hobbots inbox, ${formatCount(count)} requests need you`,
      }),
  },
  home: {
    openChat: ({ name, role, state }: { name: string; role: string; state: string }) =>
      `Open chat with ${name}, ${role}, ${state}`,
    happeningNow: "Happening now",
    allQuiet: "All quiet. No hob is replying right now.",
  },
  hobPanel: {
    label: "Hobs and threads",
    search: "Search hobs, threads, messages",
    searchLabel: "Search hobs, threads and messages",
    hide: "Hide hob list",
    hobs: "Hobs",
    loading: "Loading hobs…",
    loadFailed: "Could not load your hobs.",
    rooms: "Rooms: the great hall",
    later: "Later",
    summon: "+ Summon a hob",
    keys: "⌘K jump anywhere · ⌥↑ ⌥↓ switch threads",
    threadCount: ({ count }: { count: number }) => (plural.select(count) === "one" ? "1 thread" : `${count} threads`),
    newThread: "+ New thread",
    working: "Working",
  },
  search: {
    results: ({ count }: { count: number }) => (plural.select(count) === "one" ? "1 result" : `${count} results`),
    searching: "Searching…",
    failed: "Could not search. Try again.",
    nothing: ({ query }: { query: string }) => `Nothing matches “${query}”.`,
    matches: ({ count }: { count: number }) => `${count} matches`,
  },
  jump: {
    label: "Jump anywhere",
    input: "Find a hob, thread or message",
    placeholder: "Jump to a hob or thread…",
    list: "Hobs and threads",
    open: "↵ open",
  },
  chat: {
    ideas: ["Summarize an article I paste", "Help me plan my week", "Explain a concept simply"],
    newThread: "New thread",
    showNav: "Show hob list",
    hidePanel: "Hide Quest panel",
    showPanel: "Show Quest panel",
    hello: ({ name }: { name: string }) => `Hello, I'm ${name}!`,
    freshPage: "A fresh page",
    helloBody: "Tell me my first chore. I keep working even if you switch to another thread.",
    freshBody: ({ name }: { name: string }) =>
      `Tell ${name} what you need. It keeps working even if you switch to another thread.`,
    waiting: "Waiting to send",
    waitingRefused: "◷ Not sent yet. It stays here until you try again or edit it.",
    waitingSending: "◷ Sending…",
    waitingOffline: "◷ Waiting to send. It goes out when we reconnect.",
    edit: "Edit",
    tryAgain: "Try again",
    brainUnavailable: "Brain unavailable",
    continueFailed: ({ name, why }: { name: string; why: string }) => `${name} could not continue that reply. ${why}`,
    queueGone: "That message already started or was removed.",
    wakeFailed: ({ name }: { name: string }) => `Hobbots could not wake ${name}. Try again.`,
    brainProblem: ({ name, runtime, problem }: { name: string; runtime: string; problem: string }) =>
      `${name} can't think right now: ${runtime} ${problem}.`,
    brain: {
      notFound: "is not installed on this Mac",
      notStarted: "did not start",
      outdated: "is older than Hobbots supports",
      signedOut: "is signed out",
    },
    fixInSettings: "Fix it in Settings",
    placeholder: ({ name, title }: { name: string; title: string }) => `Message ${name} in “${title}”…`,
  },
  composer: {
    pausedPlaceholder: ({ name }: { name: string }) => `${name} is paused. Wake ${name} to start a thread.`,
    stop: "■ Stop",
    stopping: "Stopping…",
    wake: ({ name }: { name: string }) => `Wake ${name}`,
    queue: "Queue",
    send: "Send",
    hintStopping: "Stopping this reply. What was written so far is kept.",
    hintBusy: "Stop ends this reply only. Messages you send now wait their turn.",
    hintPausedQueue: ({ name }: { name: string }) =>
      `${name} is paused. Messages you queue wait until you wake ${name}.`,
    hintPausedNew: ({ name }: { name: string }) =>
      `Paused hobs take no new work. Your draft stays here until you wake ${name}.`,
    hint: "Enter sends · Shift+Enter adds a line · ↑ brings back your last message",
  },
  reply: {
    thinking: ({ name }: { name: string }) => `${name} is thinking`,
    stopping: "Stopping this reply…",
    stopped: ({ name }: { name: string }) => `■ You stopped this reply. ${name} kept what it wrote so far.`,
    interrupted: ({ name }: { name: string }) =>
      `This reply was cut off, not by you: Hobbots restarted or ${name} was paused. What it wrote so far is kept.`,
    cutOff: ({ error }: { error: string }) => `Answer cut off: ${error}. Nothing was lost before this point.`,
    limited: ({ name, provider, refill }: { name: string; provider: string; refill: string }) =>
      `⚗ ${name} used up the ${provider} allowance for now. ${refill} What it wrote so far is kept.`,
    resuming: ({ name }: { name: string }) => `Picking up where ${name} left off…`,
    continue: "Continue from here",
    failed: ({ error }: { error: string | null }) =>
      `✗ This reply failed: ${error ?? "unknown error"}. Send your message again to retry.`,
  },
  brain: {
    trigger: ({ brain, state }: { brain: string; state: string }) => `Thinking with ${brain}, ${state}. Change brain`,
    continueFailed: ({ name }: { name: string }) => `Hobbots could not switch ${name}'s brain. Try again.`,
    title: "Think with",
    scope: "Changes this thread from its next reply.",
    freshPage: "Send a first message, then you can change this thread's brain.",
    defaultModel: "Default model",
    effort: "Effort",
    noEffort: ({ model }: { model: string }) => `${model} takes no effort setting.`,
    makeDefault: ({ name }: { name: string }) => `Also make it ${name}'s default`,
    backToDefault: ({ name, brain }: { name: string; brain: string }) => `Back to ${name}'s default: ${brain}`,
    notOnThisHub: ({ runtime }: { runtime: string }) => `Hobbots can't run ${runtime} on this hub yet.`,
    notReady: ({ runtime, state }: { runtime: string; state: string }) =>
      `${runtime} is ${state}. Fix it in Settings to think with it.`,
    failed: "Hobbots could not switch brains. Try again.",
    now: ({ brain }: { brain: string }) => `Now thinking with ${brain}`,
    next: ({ brain }: { brain: string }) => `The next reply thinks with ${brain}`,
    continueWith: ({ runtime }: { runtime: string }) => `Continue with ${runtime}`,
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
      uncertain: "outcome unknown",
    },
    running: ({ label }: { label: string }) => `${label}…`,
    awaiting: "Waiting for your approval.",
    failed: "The tool reported an error.",
    unfinished: "The reply ended before this step finished.",
    uncertain:
      "Cut off while it ran, so it may or may not have taken effect. Hobbots won't run it again. Check it before you continue.",
    deniedByPolicy: ({ reason }: { reason: string }) => `Not allowed by the hob's permissions: ${reason}`,
    deniedBySandbox: ({ reason }: { reason: string }) => `Blocked by the sandbox: ${reason}`,
    deniedByUser: ({ reason }: { reason: string }) => `You denied this: ${reason}`,
    tool: "Tool",
    operation: "Action",
    targets: "On",
    noTargets: "Nothing in particular",
    output: "Output",
    omitted: ({ size }: { size: string }) => `${size} left out here`,
    openLog: ({ size }: { size: string }) => `Open the full log (${size})`,
    noLog: "The full log could not be kept.",
    started: "Started",
  },
  approval: {
    asks: ({ name }: { name: string }) => `${name} asks permission`,
    expires: "Expires if this reply stops or Hobbots restarts.",
    expiresToday: ({ time }: { time: string }) =>
      `Expires at ${time} if nobody decides, or sooner if this reply stops or Hobbots restarts.`,
    expiresTomorrow: ({ time }: { time: string }) =>
      `Expires tomorrow at ${time} if nobody decides, or sooner if this reply stops or Hobbots restarts.`,
    expiresNow: "Expiring now. Nobody decided in time.",
    action: "Action",
    target: "On",
    noTarget: "Nothing in particular",
    askedBy: "Asked by",
    chain: ({ name }: { name: string }) => `You → ${name}`,
    why: "Why now",
    risk: "Risk",
    allowOnce: "Allow once",
    always: "Always for this site",
    alwaysIntro: ({ name }: { name: string }) =>
      `Hobbots saves this rule, and ${name} stops asking for what it covers. You can remove it later.`,
    rulesLabel: "The rule to save",
    narrowLabel: "What the rule covers",
    wholeFolder: "Every file directly in the folder",
    exactFiles: "Only the files of this action",
    saveRule: "Save the rule and allow",
    noRule: "No saved rule can answer this action, so Hobbots asks each time.",
    rule: {
      folder: {
        "read-files": ({ name, folder }: { name: string; folder: string }) =>
          `Always let ${name} read files directly in ${folder}`,
        "edit-files": ({ name, folder }: { name: string; folder: string }) =>
          `Always let ${name} create and edit files directly in ${folder}`,
        "delete-files": ({ name, folder }: { name: string; folder: string }) =>
          `Always let ${name} delete files directly in ${folder}`,
      },
      paths: {
        "read-files": ({ name, paths }: { name: string; paths: string }) => `Always let ${name} read ${paths}`,
        "edit-files": ({ name, paths }: { name: string; paths: string }) =>
          `Always let ${name} create and edit ${paths}`,
        "delete-files": ({ name, paths }: { name: string; paths: string }) => `Always let ${name} delete ${paths}`,
      },
      command: ({ name, command, folder }: { name: string; command: string; folder: string }) =>
        `Always let ${name} run ${command} in ${folder}`,
      host: ({ name, host }: { name: string; host: string }) => `Always let ${name} use ${host}`,
      push: ({ name, branch, remote, folder }: { name: string; branch: string; remote: string; folder: string }) =>
        `Always let ${name} push ${folder} to ${branch} on ${remote}`,
      runner: ({ name, command, file }: { name: string; command: string; file: string }) =>
        `${command} runs what this folder's ${file} says. If ${name} changes that file, the rule runs the new version.`,
    },
    highRisk: "High risk · once only",
    confirm: ({ name }: { name: string }) => `I checked this action. Let ${name} do it this once.`,
    notConfirmed: "Tick the box to confirm this action first.",
    deny: "Deny",
    reasonLabel: ({ name }: { name: string }) => `Tell ${name} why (optional)`,
    confirmDeny: "Deny",
    cancel: "Cancel",
    sending: "Sending your decision…",
    approved: ({ name }: { name: string }) => `✓ Allowed once. ${name} carries on.`,
    approvedAlways: ({ name }: { name: string }) => `✓ Allowed, and the rule is saved. ${name} carries on.`,
    denied: ({ name }: { name: string }) => `✕ Denied. ${name} was told it may not.`,
    deniedWithReason: ({ name, reason }: { name: string; reason: string }) =>
      `✕ Denied: “${reason}”. ${name} was told why.`,
    expired: "◷ Expired before anyone decided. Nothing ran.",
    closed: "This request was already decided or has expired.",
    changed: "This action changed since it was shown. Check it again.",
    failed: "Hobbots could not send your decision. Try again.",
    ruleRefused: "Hobbots could not save this rule. Cancel to allow it once instead.",
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
  signing: {
    label: "Sign commits with my 1Password key",
    off: ({ name }: { name: string }) =>
      `${name}'s commits are unsigned. Turning this on lets ${name}'s commands reach 1Password's SSH agent, so commits are signed when your Git config asks for it (commit.gpgsign with 1Password's op-ssh-sign). The agent can also log in to servers and push over SSH with your keys. macOS only.`,
    on: ({ name }: { name: string }) =>
      `${name}'s commands can reach 1Password's SSH agent, so commits are signed when your Git config asks for it (commit.gpgsign with 1Password's op-ssh-sign). They can also use your SSH keys to log in to servers and push over SSH, whenever 1Password allows it. Turning this off stops ${name}'s running reply.`,
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
