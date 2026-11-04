import { formatCount, plural as pluralForm } from "../lib/format.ts";

/**
 * User-facing copy for the components in this folder, grouped by feature (STD-I18N-001). Copy moves
 * here from a component when that component next changes.
 */
/** Evidence from the hub as a sentence, ending with one period. */
const sentence = (text: string) => text.replace(/\.?$/, ".");

const plural = new Intl.PluralRules("en");

export const messages = {
  providers: {
    names: { "claude-code": "Claude", codex: "Codex" },
    makers: { "claude-code": "Anthropic · Claude Code", codex: "OpenAI · ChatGPT plan" },
    /** The providers the user connected, already joined as a list in the reader's locale. */
    connected: ({ names }: { names: string }) => `${names} connected`,
    connectedCount: ({ count }: { count: number }) =>
      pluralForm(count, { one: "1 provider connected", other: `${formatCount(count)} providers connected` }),
    plan: { "claude-code": "Your Claude plan", codex: "Your ChatGPT plan" },
  },
  onboarding: {
    back: "Back",
    continue: "Continue",
    /** The first hob in the summary of the steps so far, such as "Pip the Writer on Claude". */
    hobOn: ({ hob, provider }: { hob: string; provider: string }) => `${hob} on ${provider}`,
    presetSafety: ({ preset }: { preset: string }) => `${preset} safety`,
    providers: {
      guide: {
        looking: "Welcome, friend! Let me peek around your Mac for an AI helper you already use.",
        found: ({ provider }: { provider: string }) =>
          `There it is! ${provider} is ready on this Mac. Connect it, and your hobs will think with it.`,
        connected: "Splendid! That door is open, so your hobs can think with it. Continue when you like.",
        fix: "Your hobs need an AI to think with. Each one here needs a little fix first; follow the steps, then check again.",
        nudge: "Connect one provider first, otherwise the hobs have nothing to think with!",
      },
      heading: "Which AI do you already use?",
      intro:
        "Hobs think with your own subscription or key. Either one is enough, and you can change this any time in Settings.",
      privacy: "Hobbots never sees your password. It reuses the tool already signed in on this Mac.",
      tags: {
        found: "Found",
        connected: "Found",
        notFound: "Not found",
        notStarted: "Not working",
        outdated: "Update needed",
        signedOut: "Signed out",
        unknown: "Unknown",
      },
      // Each `{command}` is shown as code.
      claude: {
        checking: "Looking for Claude Code on this Mac.",
        ready: ({ version }: { version: string | null }) =>
          version ? `Claude Code ${version} is signed in on this Mac.` : "Claude Code is signed in on this Mac.",
        notFound: "Claude Code is not on this Mac yet. Install it, sign in once in Terminal, then check again.",
        notStarted: "Claude Code is installed but did not start. Run {command} in Terminal to see what is wrong.",
        outdated: ({ version }: { version: string | null }) =>
          version ? `Claude Code ${version} is too old for Hobbots.` : "Claude Code is too old for Hobbots.",
        signedOut:
          "Claude Code is installed but not signed in. Run {command} in Terminal and sign in with your claude.ai account.",
        command: "claude",
        unknown: "Hobbots could not check Claude Code just now.",
        update: "Run {command} in Terminal. Your sign-in stays as it is.",
        updateCommand: "claude update",
      },
      codex: {
        checking: "Looking for Codex on this Mac.",
        ready: ({ version }: { version: string | null }) =>
          version
            ? `Codex ${version} is signed in with your ChatGPT plan on this Mac.`
            : "Codex is signed in with your ChatGPT plan on this Mac.",
        unknown: "Hobbots could not check Codex just now.",
      },
      noRestart: "No need to restart Hobbots after fixing it.",
      installGuide: "Install guide",
      checkAgain: "Check again",
      connecting: "Knocking on the door",
      disconnecting: "Closing the door",
      looking: "Looking on this Mac",
      notConnected: "Not connected",
      connect: "Connect",
      connectLabel: ({ provider }: { provider: string }) => `Connect ${provider}`,
      connected: "✓ Connected",
      disconnect: "Disconnect",
      disconnectLabel: ({ provider }: { provider: string }) => `Disconnect ${provider}`,
      saveFailed: "Hobbots could not save that. Try again in a moment.",
      connectOne: "Connect at least one to continue",
      later: {
        tag: "Later",
        arrives: "Arrives in a later version",
        label: ({ provider }: { provider: string }) => `${provider}, coming later`,
        gemini: { name: "Gemini", maker: "Google", how: "Sign in with your Google account." },
        grok: { name: "Grok", maker: "xAI", how: "Paste an API key from your xAI account." },
        local: { name: "Local models", maker: "Ollama · LM Studio", how: "Free, private, stays on this Mac." },
        other: { name: "Other", maker: "OpenRouter · any API", how: "Any OpenAI-compatible key." },
      },
    },
    firstHob: {
      guide: "Now the fun part. Every hob has a role on your team. Pick one, a name and a cloak.",
      heading: "Meet your first hob",
      intro: "Pick a role or name your own. Every hob looks different.",
      legend: "Your first hob",
      legendSent: ({ name }: { name: string }) => `${name}, as sent`,
      role: "Role",
      chores: ({ name }: { name: string }) => `What should ${name} do?`,
      yourHob: "your hob",
      name: "Name",
      colors: "Colors",
      thinksWith: "Thinks with",
      preview: "Preview",
      newLook: "New look",
      newLookTitle: "Click for a new look",
      look: ({ seed, recipe }: { seed: number; recipe: string }) => `Look #${seed} · ${recipe}`,
      checking: "Checking your AI providers",
      connectReady: "Connect a provider that is ready first",
      waitingModels: ({ runtime }: { runtime: string }) => `Waiting for ${runtime}'s models`,
      onTheWay: ({ name }: { name: string }) => `${name} is on the way. Finish summoning to change it.`,
      ready: ({ name, role }: { name: string; role: string }) => `${name} the ${role} is ready`,
    },
    safety: {
      guide: "A good hob always asks before doing something you cannot undo. How careful should yours be?",
      heading: ({ name }: { name: string }) => `How much should ${name} ask first?`,
      intro: "Hobs read, edit, run and browse inside the folders you pick next. Pick how often they ask you first.",
      preset: "Safety preset",
    },
    folders: {
      guide: "Pick the folders your hobs share. You can give one hob more of its own later, from its profile.",
      heading: "Where can hobs work?",
      intro:
        "Every hob can work in these folders, and nowhere else on this computer. You can give one hob more folders of its own from its profile.",
      none: "No folders is fine, hobs can still chat",
    },
    ready: {
      guide: "Everything is ready. Light the circle and your first hob will appear.",
      doneGuide: "There it is! Say hello. I will be in the corner of Home if you need me.",
      heading: "Ready to summon",
      thinksWith: ({ hob, provider, model }: { hob: string; provider: string; model: string }) =>
        `${hob} · thinks with ${provider} ${model}`,
      rejected: ({ name, reason }: { name: string; reason: string }) =>
        `Hobbots could not create ${name}: ${reason}. Go back to change it.`,
      failed: ({ name }: { name: string }) => `Hobbots could not finish summoning ${name}. Try again in a moment.`,
      tryAgain: "Try again",
      summon: ({ name }: { name: string }) => `Summon ${name}`,
      calling: ({ name }: { name: string }) => `The Chief is calling ${name}…`,
      here: ({ name }: { name: string }) => `${name} is here!`,
      chiefWelcome: ({ name }: { name: string }) => `Welcome, ${name}! I'll be in the corner of Home if you need me.`,
      hobHello: ({ name, role, note }: { name: string; role: string; note: string }) =>
        `“Hi! I'm ${name}, your ${role.toLowerCase()}.${note === "" ? "" : ` ${note}`}”`,
      sayHello: ({ name }: { name: string }) => `Say hello to ${name}`,
      home: "Go to Home",
      replay: "Replay",
      replayLabel: "Replay the summoning",
    },
  },
  models: {
    loading: ({ runtime }: { runtime: string }) => `Asking ${runtime} for its models`,
    failed: ({ runtime }: { runtime: string }) => `Hobbots could not get ${runtime}'s models.`,
    retry: "Try again",
    /** How a hob thinks, such as "Codex · GPT-5.5 · medium effort". */
    brain: ({ provider, model, effort }: { provider: string; model: string; effort: string | null }) =>
      effort === null ? `${provider} · ${model}` : `${provider} · ${model} · ${effort.toLowerCase()} effort`,
    /** The summary line; {brain} is shown in bold. */
    thinksWith: "Thinks with {brain}",
    more: "More models",
    effort: "Effort",
    noEffort: ({ model }: { model: string }) => `${model} takes no effort setting.`,
  },
  providerChoice: {
    legend: "Provider",
    /** A provider that cannot be picked, as a screen reader hears its choice. */
    unavailable: ({ provider, state }: { provider: string; state: string }) => `${provider}, ${state.toLowerCase()}`,
  },
  setup: {
    failed: "Hobbots could not read your setup.",
    retry: "Try again",
  },
  profile: {
    saving: "Saving…",
    rejected: ({ reason }: { reason: string }) => `Hobbots could not save: ${reason}.`,
    failed: "Hobbots could not save the changes. Try again.",
    unsaved: ({ name }: { name: string }) => `Unsaved changes. ${name}'s next reply uses them once saved.`,
    saved: ({ version, name }: { version: number; name: string }) =>
      `Saved as version ${version}. ${name}'s next reply uses it.`,
    role: "Role",
    tone: "Tone",
    toneNote: ({ name }: { name: string }) => `How ${name} talks. If your instructions describe a voice too, they win.`,
    instructions: "Instructions",
    instructionsNote: ({ name }: { name: string }) =>
      `${name} reads this before every reply, after its name, role and tone. Add anything else it should know.`,
    brain: "Brain",
    backToPage: ({ name }: { name: string }) => `Back to ${name}'s page`,
    discard: "Discard",
    save: "Save changes",
    look: {
      heading: "Name and look",
      change: "Change name or look",
      done: "Done",
      name: "Name",
      lookGroup: "Look",
      lookOption: ({ index }: { index: number }) => `Look ${index}`,
      colorGroup: "Color",
      hat: "Hat",
      tool: "Tool",
      fromLook: "From the look",
      note: ({ name }: { name: string }) =>
        `A new name shows everywhere, in past chats too. ${name} hears it from its next reply.`,
    },
  },
  summon: {
    checkAgain: "Check again",
    checking: "Checking…",
    checkingProviders: "Checking your AI providers",
    checkFailed: "Hobbots could not check your AI providers.",
    checkAgainToSummon: ({ name }: { name: string }) => `Check your AI providers again to summon ${name}`,
    fixProvider: ({ name }: { name: string }) => `Fix a provider to summon ${name}`,
    summoning: ({ name }: { name: string }) => `Summoning ${name}… If you leave now, ${name} still joins your hobs.`,
    rejected: ({ name, reason }: { name: string; reason: string }) => `Hobbots could not create ${name}: ${reason}.`,
  },
  chief: {
    home: "Hobbots home",
    working: "Hobbots home, hobs are working",
    needsYou: ({ count }: { count: number }) =>
      pluralForm(count, {
        one: "Hobbots inbox, something needs you",
        other: `Hobbots inbox, ${formatCount(count)} things need you`,
      }),
  },
  home: {
    openPage: ({ name, role, state }: { name: string; role: string; state: string }) =>
      `Open ${name}'s page, ${role}, ${state}`,
    peekLabel: ({ name, role, state }: { name: string; role: string; state: string }) => `${name}, ${role}, ${state}`,
    peekResting: "Nothing on right now.",
    openChat: "Open chat",
    openWorkbench: "Open Workbench",
    chips: {
      label: "Show hobs",
      all: "All",
      needs: "Need you",
      working: "Working",
      resting: "Resting",
    },
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
    /** A Hobbots tool call the hub refused, such as answering a question the user owns (#575). */
    refused: ({ why }: { why: string }) => `Hobbots refused this: ${why}`,
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
  charmCall: {
    ask: "Look on GitHub to see whether it went through, then tell Hobbots. Until you do, no hob makes this call to the same place again.",
    applied: "It went through",
    notSent: "It did not go through",
    error: "Hobbots could not settle it. It may have settled already; the step shows how.",
    /** How a call settled, by its state now. */
    settled: {
      applied: "Settled: it went through.",
      "not-sent": "Settled: it did not go through, so it can be made again.",
      refused: "Settled: GitHub refused it.",
    },
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
    /** The middle lifetime (ADR 018): This Task, or This Quest once a party joins the Task. */
    forWork: { task: "This Task", quest: "This Quest" },
    forWorkIntro: {
      task: ({ name }: { name: string }) =>
        `Hobbots saves this rule for this Task only. ${name} stops asking for what it covers, in every step, until the Task ends.`,
      quest: ({ name }: { name: string }) =>
        `Hobbots saves this rule for this Quest only. ${name} stops asking for what it covers until the Quest ends. Other hobs on the Quest still ask.`,
    },
    saveForWork: { task: "Save for this Task and allow", quest: "Save for this Quest and allow" },
    /** A rule in words, by how long it lasts. */
    ruleFor: {
      always: ({ rule }: { rule: string }) => `Always ${rule}`,
      task: ({ rule }: { rule: string }) => `For this Task, ${rule}`,
      quest: ({ rule }: { rule: string }) => `For this Quest, ${rule}`,
    },
    rulesLabel: "The rule to save",
    narrowLabel: "What the rule covers",
    wholeFolder: "Every file directly in the folder",
    exactFiles: "Only the files of this action",
    saveRule: "Save the rule and allow",
    noRule: "No saved rule can answer this action, so Hobbots asks each time.",
    rule: {
      folder: {
        "read-files": ({ name, folder }: { name: string; folder: string }) =>
          `let ${name} read files directly in ${folder}`,
        "edit-files": ({ name, folder }: { name: string; folder: string }) =>
          `let ${name} create and edit files directly in ${folder}`,
        "delete-files": ({ name, folder }: { name: string; folder: string }) =>
          `let ${name} delete files directly in ${folder}`,
      },
      paths: {
        "read-files": ({ name, paths }: { name: string; paths: string }) => `let ${name} read ${paths}`,
        "edit-files": ({ name, paths }: { name: string; paths: string }) => `let ${name} create and edit ${paths}`,
        "delete-files": ({ name, paths }: { name: string; paths: string }) => `let ${name} delete ${paths}`,
      },
      command: ({ name, command, folder }: { name: string; command: string; folder: string }) =>
        `let ${name} run ${command} in ${folder}`,
      host: ({ name, host }: { name: string; host: string }) => `let ${name} use ${host}`,
      push: ({ name, branch, remote, folder }: { name: string; branch: string; remote: string; folder: string }) =>
        `let ${name} push ${folder} to ${branch} on ${remote}`,
      pullRequest: ({ name, repository, base }: { name: string; repository: string; base: string }) =>
        `let ${name} open pull requests into ${base} in ${repository}`,
      comment: ({ name, repository }: { name: string; repository: string }) =>
        `let ${name} comment on issues and pull requests in ${repository}`,
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
    approvedForTask: ({ name }: { name: string }) =>
      `✓ Allowed for the rest of this Task. ${name} carries on, and asks again once the Task ends.`,
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
      "read-github": "Reads only. Nothing changes.",
      "open-pull-request": "Opens a pull request others can see at once. You can close or edit it.",
      "comment-github": "Posts a comment others can see at once. You can edit or delete it.",
      "outside-folders": "Acts outside the folders this hob may use.",
    },
  },
  charms: {
    github: {
      name: "GitHub",
      reads: ({ name }: { name: string }) =>
        `Reads, pushes to, opens pull requests in and comments on the repository of ${name}'s folders, as you. The hub reaches GitHub with the account you connected in Settings, so no key reaches ${name}.`,
      readsAsBot: ({ name, bot }: { name: string; bot: string }) =>
        `Reads, pushes to, opens pull requests in and comments on the repository of ${name}'s folders, as ${bot}. The hub keeps the app's key, so no key reaches ${name}.`,
      read: "Read",
      push: "Push",
      pullRequests: "Pull requests",
      comment: "Comment",
      grant: ({ name }: { name: string }) => `Let ${name} use GitHub`,
      off: ({ name }: { name: string }) => `${name} is offered no GitHub action until you turn this on.`,
      notConnected: "GitHub is not connected on this hub yet, so no hob can use it.",
      connectInSettings: "Connect GitHub in Settings",
      saveFailed: "Hobbots could not save this. Try again.",
      /** The hob's own GitHub App (ADR 022). */
      app: {
        label: "Acts on GitHub as",
        failed: "Hobbots could not read who this hob acts as on GitHub.",
        retry: "Try again",
        asYou: ({ name }: { name: string }) =>
          `${name} acts as you, with the account connected in Settings. Its commits, pull requests and comments carry your name.`,
        give: ({ name }: { name: string }) => `Give ${name} its own GitHub app`,
        giveNote: ({ name }: { name: string }) =>
          `GitHub opens in your browser, where you name the app and pick its repositories. ${name}'s work then shows on GitHub as its own bot, never as you.`,
        noKeychain: "This hub has no keychain Hobbots can use, so it cannot keep a hob's own GitHub app.",
        finishOnGitHub: ({ name }: { name: string }) =>
          `Finish on GitHub, in the browser that just opened. This updates once ${name}'s app is made.`,
        openAgain: "Open GitHub again",
        restartNote:
          "Each start works once. If GitHub said the app was not kept, or the page stopped working, start again.",
        restart: "Start again",
        expired: "The last start ran out before the app was made. Start again when you're ready.",
        startFailed: "Hobbots could not start making the app. Try again.",
        actsAs: "Acts as",
        since: ({ since }: { since: string }) => `Since ${since}.`,
        installedLabel: "Installed on",
        installation: ({ account, all }: { account: string; all: boolean }) =>
          all ? `@${account}: every repository` : `@${account}: the repositories you picked`,
        suspended: "suspended",
        change: "Change on GitHub",
        reaches: ({ account }: { account: string }) => `Repositories @${account} lets it reach`,
        noRepositories: "No repositories yet",
        moreRepositories: ({ count }: { count: number }) => `and ${count} more`,
        notInstalled: ({ name }: { name: string }) =>
          `Not installed on any repository yet, so ${name} can't act on GitHub. Install it on the repositories ${name} should reach.`,
        install: "Install on GitHub",
        installationsFailed: "Hobbots could not ask GitHub where the app is installed.",
        reconnectTitle: "Needs a reconnect",
        reconnectKey: ({ name }: { name: string }) =>
          `GitHub no longer accepts the app's key: it was revoked, or the app was deleted. ${name}'s GitHub actions fail until it has a new app. They never run as you instead.`,
        reconnectInstallation: ({ name }: { name: string }) =>
          `GitHub no longer lets the app into its repositories: it was uninstalled or suspended. ${name}'s GitHub actions fail until you reinstall it. They never run as you instead.`,
        newApp: ({ name }: { name: string }) => `Give ${name} a new app`,
        reinstall: "Reinstall on GitHub",
        disconnect: "Disconnect",
        confirmDisconnect: ({ name }: { name: string }) =>
          `Disconnect ${name}'s app? The hub removes it from your repositories and deletes its key. ${name} then acts as you again.`,
        cancel: "Cancel",
        disconnected: ({ name }: { name: string }) =>
          `Disconnected. ${name} acts as you again. The app itself stays on GitHub until you delete it there.`,
        deleteOnGitHub: "Delete the app on GitHub",
        leftOver: ({ name }: { name: string }) => `${name}'s old app was not fully removed. It no longer acts.`,
        dismiss: "Dismiss",
        changeFailed: "Hobbots could not change the app. Try again.",
      },
    },
  },
  github: {
    heading: "Charms",
    intro:
      "Charms connect hobs to other apps. Connect one here once, then choose which hobs use it from each hob's Charms tab.",
    name: "GitHub",
    failed: "Hobbots could not read your GitHub connection. Try again in a moment.",
    retry: "Try again",
    environment: "Connected with the HOBBOTS_GITHUB_TOKEN this hub was started with.",
    connectedAs: ({ login, since }: { login: string; since: string }) => `Connected as @${login} since ${since}.`,
    through: {
      app: "Through the Hobbots GitHub App, on the repositories you install it on.",
      gh: "Through your GitHub CLI sign-in, read again for each call.",
      git: "Through the credential Git keeps for github.com, read again for each call.",
    },
    everyRepository: ({ login }: { login: string }) =>
      `Reaches every repository @${login} can see. Hobs still reach only the repository of their own folders.`,
    repositoriesLabel: "Repositories it reaches",
    noRepositories: "None yet. Install the app on the repositories hobs should reach.",
    repositoriesFailed: "Hobbots could not ask GitHub which repositories it reaches.",
    chooseRepositories: "Choose repositories on GitHub",
    permissionsLabel: "What the app may do there",
    permission: ({ name, access }: { name: string; access: "read" | "write" }) =>
      access === "read" ? `${name}: read` : `${name}: read and write`,
    private: "private",
    disconnect: "Disconnect",
    disconnected: "Disconnected. GitHub still lists Hobbots among your authorized apps until you revoke it there.",
    authorizedApps: "Open authorized apps on GitHub",
    connect: "Connect with Hobbots",
    recommended: "Recommended: hobs reach only the repositories you install the app on.",
    enterCode: "Enter this code on GitHub to connect:",
    openGitHub: "Open GitHub",
    waiting: "Waiting for you to enter the code…",
    cancel: "Cancel",
    found: "Or use a sign-in already on this computer",
    foundSource: {
      gh: ({ login }: { login: string }) => `Your GitHub CLI sign-in, as @${login}`,
      git: ({ login }: { login: string }) => `The credential Git keeps for github.com, as @${login}`,
    },
    foundNote: "Reaches every repository the sign-in can see.",
    use: "Use",
    cannotConnect: {
      "no-app":
        "This build of Hobbots names no GitHub App. Start the hub with HOBBOTS_GITHUB_CLIENT_ID to connect one.",
      "no-keychain": "This hub has no keychain Hobbots can use, so it does not keep a GitHub sign-in.",
    },
    problem: {
      expired: "The code lapsed, or the sign-in expired. Connect again.",
      denied: "GitHub says the sign-in was cancelled.",
      refused: "GitHub no longer accepts the hub's sign-in. Connect again.",
      failed: "Hobbots could not finish connecting to GitHub. Try again.",
    },
    connectFailed: {
      environment: "This hub reaches GitHub with the HOBBOTS_GITHUB_TOKEN it was started with.",
      "no-app": "This build of Hobbots names no GitHub App.",
      "no-keychain": "This hub has no keychain Hobbots can use, so it does not keep a GitHub sign-in.",
      "not-found": "That sign-in cannot be read now. Sign in again, then try once more.",
      failed: "GitHub did not answer as expected. Try again.",
    },
  },
  remoteAccess: {
    heading: "Devices",
    intro:
      "This computer is your Hobbots hub. Hobs live and work here. With remote access on, your other devices on Tailscale can reach it.",
    switchLabel: "Use Hobbots from my other devices",
    onNote: "Your devices on Tailscale can connect.",
    offNote: "Only this computer can reach Hobbots right now.",
    failed: "Hobbots could not read or change remote access. Try again in a moment.",
    connected: "Tailscale connected · this computer is",
    address: "Address",
    addressNote: "Open it in a browser on your tailnet, or scan the code from your phone.",
    why: {
      notInstalled:
        "Tailscale is not installed on this computer, so your other devices cannot reach Hobbots. Install Tailscale and sign in; Hobbots starts listening on your tailnet within seconds.",
      notRunning:
        "Tailscale is off on this computer, so Hobbots stopped listening on your tailnet. Turn Tailscale on and Hobbots listens again within seconds.",
      signedOut:
        "Tailscale is signed out on this computer, so Hobbots is not on your tailnet. Sign in to Tailscale and Hobbots listens again within seconds.",
      noAddress:
        "Tailscale is running but gave this computer no tailnet address yet, so Hobbots is not on your tailnet.",
      cannotListen: ({ detail }: { detail: string }) => `Hobbots could not listen on your tailnet: ${detail}.`,
      paused:
        "Remote access is paused from the menu-bar icon, so your other devices cannot reach Hobbots. They stay approved and work again once you resume.",
    },
    resume: "Resume remote access",
    notReady: {
      notInstalled:
        "Tailscale is not installed on this computer. Install it and sign in so your other devices can reach Hobbots.",
      notRunning: "Tailscale is off on this computer. Turn it on so your other devices can reach Hobbots.",
      signedOut: "Tailscale is signed out on this computer. Sign in so your other devices can reach Hobbots.",
    },
    getTailscale: "Get Tailscale",
    copy: "Copy",
    copied: "Copied",
    copyFailed: "Copy it by hand",
    scan: "Scan from your phone",
    qrLabel: ({ address }: { address: string }) => `QR code for ${address}`,
    port: {
      label: "Port",
      note: ({ fallback }: { fallback: number }) =>
        `Default ${fallback}. Devices on your tailnet need the new address after a change.`,
      save: "Change port",
      saving: "Changing…",
      invalid: "Pick a port from 1024 to 65535.",
      unavailable: ({ port, detail }: { port: number; detail: string }) =>
        `Hobbots could not open port ${port}: ${detail}. It still uses the old one.`,
    },
    https: {
      switchLabel: "Use HTTPS through Tailscale",
      note: "Optional. Gives you an https:// address on your tailnet, set up by Tailscale. Never on the open internet.",
      serving: "Tailscale serves Hobbots over HTTPS on your tailnet.",
      notServing:
        "Tailscale does not serve Hobbots over HTTPS yet. Run this on this computer, or let Hobbots run it for you:",
      leftOver:
        "Tailscale still forwards HTTPS to Hobbots. Remove it with this command on this computer, or let Hobbots run it for you:",
      cannotListen: ({ detail }: { detail: string }) => `Hobbots could not open its HTTPS port: ${detail}.`,
      run: "Run it for me…",
      consentOn: ({ command }: { command: string }) =>
        `Hobbots will run ${command} in the background on this computer. Tailscale then serves Hobbots to your tailnet only, never the internet.`,
      consentOff: ({ command }: { command: string }) =>
        `Hobbots will run ${command} on this computer. It removes everything Tailscale serves over HTTPS on this computer.`,
      notNow: "Not now",
      confirm: "Run it",
      running: "Running…",
      failed: ({ detail }: { detail: string }) => `Tailscale did not do it: ${detail}`,
      failedPlain: "Hobbots could not run Tailscale. Run the command yourself, or try again in a moment.",
    },
    devices: {
      heading: "Allowed devices",
      window: "This computer's Hobbots window",
      windowMeta: "The hub · hobs work here",
      using: { desktop: "The Hobbots app", browser: "A browser" },
      active: ({ when }: { when: string }) => `active ${when}`,
      notUsed: ({ day }: { day: string }) => `allowed ${day}, not used yet`,
      fromHub: "on this computer",
      revoke: "Revoke…",
      revokeLabel: ({ name }: { name: string }) => `Revoke ${name}`,
      confirm: ({ name }: { name: string }) => `Sign ${name} out now?`,
      keep: "Keep",
      confirmRevoke: "Revoke",
      revoking: "Revoking…",
      failed: "Hobbots could not read your devices. Try again in a moment.",
      revokeFailed: "Hobbots could not revoke it. Try again in a moment.",
      revokedByRestore: "Revoked by a restore",
      pairAgain: "Open Hobbots on that device to ask again.",
      footer:
        "Each new device asks once, here and with a notification. A revoked device is signed out right away and has to ask again.",
      windowOn: ({ hub }: { hub: string }) => `The Hobbots window on ${hub}`,
      onHub: ({ hub }: { hub: string }) => `on ${hub}`,
      thisMac: "this Mac",
    },
    connectedHub: {
      intro: "This Mac uses Hobbots on another computer. Hobs, chats and files live there, and hobs work there.",
      connected: ({ hub }: { hub: string }) => `Connected to ${hub}`,
      notConnected: ({ hub }: { hub: string }) => `Not connected to ${hub} right now`,
      overTailscale: "over Tailscale",
      versions: ({ hub, hubVersion, appVersion }: { hub: string; hubVersion: string; appVersion: string }) =>
        `Hobbots ${hubVersion} on ${hub} · ${appVersion} on this Mac`,
      appVersion: ({ appVersion }: { appVersion: string }) => `Hobbots ${appVersion} on this Mac`,
      managedThere: ({ hub }: { hub: string }) =>
        `Remote access, the port and HTTPS are set on ${hub}, in Settings › Devices.`,
      disconnect: "Disconnect…",
      disconnectLabel: ({ hub }: { hub: string }) => `Disconnect from ${hub}`,
      confirm: ({ hub }: { hub: string }) => `Disconnect this Mac from ${hub}?`,
      confirmNote: ({ hub }: { hub: string }) =>
        `${hub} signs this Mac out, and Hobbots here goes back to setup. Your hobs, chats and files stay on ${hub}.`,
      keep: "Keep",
      confirmDisconnect: "Disconnect",
      disconnecting: "Disconnecting…",
      failed: "Hobbots could not disconnect. Try again in a moment.",
      readFailed: "Hobbots could not read which hub this Mac uses. Try again in a moment.",
      updateToDisconnect: ({ hub }: { hub: string }) =>
        `Update Hobbots on this Mac to disconnect from here. Until then, revoke this Mac on ${hub}, in Settings › Devices.`,
    },
  },
  where: {
    stage: "Getting started",
    elder: "Elder Hob",
    speech:
      "Hello again! First, where should your hobs live? They need one home computer. Your other devices can visit it.",
    title: "Where should Hobbots run?",
    intro:
      "Your hobs live on one computer, the hub. It keeps working in the background, even with the window closed. Hobs always work on the hub, and your other devices can open it over Tailscale.",
    here: {
      title: "Run Hobbots on this computer",
      body: "This computer becomes the hub. Hobs, chats and files live here, and hobs work with this computer's folders and apps.",
      badge: "Most people start here",
    },
    connect: {
      title: "Connect to Hobbots on another computer",
      body: "Already have a hub? Use it from here with chat, Quests, approvals and the Workbench.",
      onHub: "This computer is the hub already. To use it from another computer, open Hobbots there and choose this.",
    },
    starting: "Starting Hobbots…",
    startFailed: "Hobbots could not start here. Try again in a moment.",
  },
  welcome: {
    getStarted: "Get started",
    alreadyUse: "I already use Hobbots",
    saveFailed: "Hobbots could not save that. Try again in a moment.",
  },
  remoteSetup: {
    stage: "This computer",
    eyebrow: "Optional",
    title: "Use Hobbots from your other devices too?",
    intro:
      "Open your hobs from your laptop or any browser on your own Tailscale network. Each new device asks you before it can join. Turn this on or off any time in Settings › Devices.",
    connected: "Tailscale is connected",
    thisComputer: ({ name }: { name: string }) => `This computer is ${name} on your tailnet`,
    switchLabel: "Let my other devices connect",
    switchNote: "Only this computer and your tailnet can reach Hobbots. Nothing is open to the internet.",
    address: "Your Hobbots address",
    addressNote: "Open it in any browser on your tailnet. Each new device asks you here before it can join.",
    portNote: "You can change the port later in Settings › Devices.",
    missing: {
      notInstalled: "Tailscale isn't on this computer yet",
      notRunning: "Tailscale is off on this computer",
      signedOut: "Tailscale is signed out on this computer",
    },
    missingBody: "Tailscale links your own devices privately, with nothing exposed to the internet.",
    steps: [
      "Install Tailscale, or open it, and sign in.",
      "Sign in with the same account on your other devices.",
      "Come back here. Hobbots checks again by itself.",
    ],
    checkAgain: "Check again",
    checking: "Checking…",
    back: "Back",
    skip: "Skip for now",
    continue: "Continue",
    hintOn: "Other devices can connect after you allow them",
    hintOff: "You can turn this on later",
    elder: {
      ready: "Want your hobs on your laptop or phone too? Tailscale makes a private path between your own devices.",
      missing: "Tailscale is not ready on this computer yet. You can skip this and turn it on later in Settings.",
    },
  },
  deviceAccess: {
    removedTitle: ({ hub }: { hub: string }) => `This device was removed from ${hub}`,
    removedTitleNoName: "This device was removed from the hub",
    removedBody:
      "Someone revoked it, so it can no longer reach your hobs. Ask again, then allow it on the hub, to use Hobbots here.",
    askAgain: "Ask again",
    reconnecting: "Reconnecting to Hobbots… Messages you send wait here and go out when it is back.",
    unreachable: ({ hub }: { hub: string }) =>
      `Hobbots cannot reach ${hub}. The hub may be off, or remote access may be paused. Messages you send wait here.`,
    unreachableNoName:
      "Hobbots cannot reach the hub. It may be off, or remote access may be paused. Messages you send wait here.",
    tryNow: "Try now",
  },
  connectionBanner: {
    tryNow: "Try now",
    openTailscale: "Open Tailscale",
    changeAddress: "Change address",
    addressLabel: "Hub address",
    connect: "Connect",
    connecting: "Checking…",
    cancel: "Cancel",
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
