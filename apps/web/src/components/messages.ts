import { formatCount, plural as pluralForm } from "../lib/format.ts";

/**
 * User-facing copy for the components in this folder, grouped by feature (STD-I18N-001). Copy moves
 * here from a component when that component next changes.
 */
/** Evidence from the hub as a sentence, ending with one period. */
const sentence = (text: string) => text.replace(/\.?$/, ".");

export const messages = {
  providers: {
    names: { "claude-code": "Claude", codex: "Codex" },
    makers: { "claude-code": "Anthropic · Claude Code", codex: "OpenAI · ChatGPT plan" },
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
    frame: {
      stage: "Set up Hobbots",
      stageStep: ({ step, of }: { step: number; of: number }) => `Set up Hobbots · Step ${step} of ${of}`,
      stageExtra: "Set up Hobbots · Optional extra",
      steps: "Setup steps",
      stepNames: ["Your AI", "First hob", "Safety", "Folders", "Ready"],
      preview: "Preview",
      chief: "The Chief",
      soFar: "So far",
      notYet: "Not yet",
      summaryNames: ["Your AI", "First hob", "Safety", "Folders", "Other devices"],
      yourHob: "Your hob",
      folders: ({ count }: { count: number }) =>
        pluralForm(count, { one: "1 folder", other: `${formatCount(count)} folders` }),
      noFolders: "No folders",
      devicesOn: "On",
      devicesLater: "Later",
    },
    providers: {
      guide: {
        looking: "Let me peek around this Mac for an AI you already use…",
        found: ({ provider }: { provider: string }) =>
          `There it is! ${provider} is on this Mac. Connect it and my lantern will light up.`,
        connected: "Splendid! That door is open, so your hobs can think with it. Continue when you like.",
        fix: "Your hobs need an AI to think with. Each one here needs a little fix first; follow the steps, then check again.",
        nudge: "Connect one provider first, otherwise the hobs have nothing to think with!",
      },
      heading: "Which AI should your hobs think with?",
      intro: "Hobbots works with the AI plan you already pay for. Nothing new to buy.",
      checksItself: "Hobbots also checks by itself every few seconds.",
      preview: {
        looking: "Looking…",
        lookingCaption: "Looking for an AI…",
        found: ({ provider }: { provider: string }) => `${provider} found`,
        fix: "Needs a fix",
        connected: "Connected, so your hobs can think",
        notYet: "Not connected yet",
      },
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
      connecting: "Knocking on the door…",
      disconnecting: "Closing the door…",
      looking: "Looking on this Mac…",
      notConnected: "Not connected",
      connect: "Connect",
      connectLabel: ({ provider }: { provider: string }) => `Connect ${provider}`,
      connected: "✓ Connected",
      disconnect: "Disconnect",
      disconnectLabel: ({ provider }: { provider: string }) => `Disconnect ${provider}`,
      saveFailed: "Hobbots could not save that. Try again in a moment.",
      connectOne: "Connect at least one to continue",
      brain: {
        heading: "The hub's brain",
        intro:
          "Hobbots' own small helper, outside any hob's turn: it sums up chats for memory and, once camps arrive, writes a camp's brief and makes quick judgment calls. A small, fast model is enough.",
        model: "Model",
        recommended: "Recommended",
        lines: {
          recommended:
            "Picked for you: the smallest model on the plan you just connected, at low reasoning effort. Short summaries and quick calls need no more, and it leaves the most of your plan for your hobs. Its calls show in Usage.",
          bigger:
            "It still runs at low reasoning effort: a bigger model is slower and uses more of your plan, with little gain for this work. Its calls show in Usage. Change it any time in Settings › Your data.",
          none: "Summaries and briefs follow simple rules, with no AI. Free, and nothing leaves this Mac. Change it any time in Settings › Your data.",
        },
        reading: "Reading the hub's brain…",
        readFailed: "Hobbots could not read the hub's brain, so setup can't pick it yet.",
        saveFailed:
          "Hobbots could not save the hub's brain. Pick it again, or change it later in Settings › Your data.",
      },
      later: {
        heading: "Or connect another",
        tag: "Later",
        label: ({ provider }: { provider: string }) => `${provider}, coming later`,
        gemini: { name: "Gemini", maker: "Google", how: "Sign in with your Google account." },
        grok: { name: "Grok", maker: "xAI", how: "Paste an API key from your xAI account." },
        local: { name: "Local models", maker: "Ollama · LM Studio", how: "Free, private, stays on this Mac." },
        other: { name: "Other", maker: "OpenRouter · any API", how: "Any OpenAI-compatible key." },
      },
    },
    firstHob: {
      guide: "Now the fun part. Who should help you first? Watch them take shape here.",
      heading: "Who should help you first?",
      intro: "Pick the closest one. You can summon more hobs any time.",
      legend: "Your first hob",
      legendSent: ({ name }: { name: string }) => `${name}, as sent`,
      yourHob: "your hob",
      fromRole: "Hat, tool and voice come from its role. Change them any time in its profile.",
      checking: "Checking your AI providers",
      connectReady: "Connect a provider that is ready first",
      waitingModels: ({ runtime }: { runtime: string }) => `Waiting for ${runtime}'s models`,
      onTheWay: ({ name }: { name: string }) => `${name} is on the way. Finish summoning to change it.`,
      ready: ({ name, role }: { name: string; role: string }) => `${name} the ${role} is ready`,
    },
    safety: {
      guide: "A good hob always asks before doing something you cannot undo. How careful should yours be?",
      heading: "How careful should your hobs be?",
      intro: "Whatever you pick, hobs never leave the folders you give them.",
      preset: "Safety preset",
    },
    folders: {
      guide: "Pick the folders your hobs share. You can give one hob more of its own later, from its profile.",
      heading: "Where can hobs work?",
      intro: "Pick the folders your hobs may read and change. Everything else on this computer stays closed to them.",
      none: "No folders is fine, hobs can still chat",
    },
    ready: {
      guide: ({ name }: { name: string }) => `All set. Light the circle and I'll call ${name}.`,
      heading: "Everything is ready",
      intro: "Here's what you picked. Light the circle and the Chief will call your first hob.",
      change: ({ step }: { step: string }) => `Change ${step}`,
      changeShort: "Change",
      devicesLater: "Later, in Settings",
      /** The effort the first hob starts on, beside its AI and model: it can change later in its profile. */
      effort: {
        low: "Low effort",
        medium: "Medium effort",
        high: "High effort",
        xhigh: "Extra high effort",
        max: "Max effort",
      },
      rejected: ({ name, reason }: { name: string; reason: string }) =>
        `Hobbots could not create ${name}: ${reason}. Go back to change it.`,
      failed: ({ name }: { name: string }) => `Hobbots could not finish summoning ${name}. Try again in a moment.`,
      tryAgain: "Try again",
      summon: "Light the circle",
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
    loading: ({ runtime }: { runtime: string }) => `Asking ${runtime} for its models…`,
    slow: ({ runtime }: { runtime: string }) => `${runtime} is slow to answer. Your hobs keep working.`,
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
    status: ({ provider, state }: { provider: string; state: string }) => `${provider}: ${state}`,
    legend: "Provider",
    /** A provider that cannot be picked, as a screen reader hears its choice. */
    unavailable: ({ provider, state }: { provider: string; state: string }) => `${provider}, ${state.toLowerCase()}`,
  },
  setup: {
    failed: "Hobbots could not read your setup.",
    retry: "Try again",
  },
  profile: {
    missing: "This hob is not here",
    missingNote: "It may have retired. Retired hobs live in the Archive.",
    landmark: ({ name }: { name: string }) => `${name}'s profile`,
    tabs: "Profile",
    saving: "Saving…",
    rejected: ({ reason }: { reason: string }) => `Hobbots could not save: ${reason}.`,
    failed: "Hobbots could not save the changes. Try again.",
    role: "Role",
    toneNote: ({ name }: { name: string }) =>
      `If your instructions describe a voice too, they win over ${name}'s tone.`,
    openChat: "Open chat",
    moreActions: ({ name }: { name: string }) => `More actions for ${name}`,
    talks: ({ name }: { name: string }) => `How ${name} talks`,
    thinks: ({ name }: { name: string }) => `How ${name} thinks`,
    connectAnother: "Connect another AI in Settings",
    visibility: {
      heading: "Other hobs",
      label: "Visible to other hobs",
      on: ({ name }: { name: string }) =>
        `Other hobs see ${name}'s name, role, what it is good at, whether it is paused, the AI it thinks with and its Charms. Never its instructions, memory or threads.`,
      off: ({ name }: { name: string }) =>
        `Other hobs don't see ${name} at all. A hob you tell to give ${name} a Task can still find it by name.`,
    },
    changeRole: "Change role",
    noTitle: "No title yet",
    ownRole: "A role in your own words.",
    goodAt: "Good at",
    goodAtNote: ({ name }: { name: string }) =>
      `Other hobs read this to know when to come to ${name}. It never changes how ${name} behaves. Every hob can see it, so keep anything private out.`,
    shouldDo: ({ name }: { name: string }) => `What ${name} should do`,
    shouldDoNote: ({ name }: { name: string }) =>
      `${name} reads this before every reply. Write it the way you would brief a person.`,
    notSaved: ({ count }: { count: number }) =>
      count === 1 ? "1 change not saved yet" : `${count} changes not saved yet`,
    nextReply: ({ name }: { name: string }) =>
      `${name}'s next reply uses the new settings. Replies already running finish the old way.`,
    savedNow: ({ name }: { name: string }) =>
      `Saved. ${name}'s next reply uses the new settings. Replies already running finish the old way.`,
    undo: "Undo",
    save: "Save changes",
    /** The line under the profile: where the hob works, who summoned it and when, and its version. */
    about: {
      line: ({ summoned, version }: { summoned: string; version: number }) =>
        `Works on the hub · ${summoned} · Version ${version}`,
      byYou: ({ date }: { date: string }) => `Summoned by you on ${date}`,
      byHob: ({ hob, date }: { hob: string; date: string }) => `Summoned by ${hob} on ${date}`,
      /** A summoner that is no longer kept. */
      byGone: ({ date }: { date: string }) => `Summoned by another hob on ${date}`,
      /** While the hob that summoned it is still being looked up, or could not be. */
      byUnknown: ({ date }: { date: string }) => `Summoned on ${date}`,
      failed: "Hobbots could not read which hob summoned it.",
      retry: "Try again",
    },
    rest: {
      heading: "Take a break",
      pause: ({ name }: { name: string }) => `Pause ${name}`,
      wake: ({ name }: { name: string }) => `Wake ${name}`,
      pauseLine: ({ name }: { name: string }) => `Pausing stops ${name} from starting new work. Wake it any time.`,
      pausedLine: ({ name }: { name: string }) =>
        `${name} is paused. It starts nothing new until you wake it. Its threads stay where they are.`,
      pauseFailed: ({ name, paused }: { name: string; paused: boolean }) =>
        `Hobbots could not ${paused ? "wake" : "pause"} ${name}. Try again.`,
      retireLine: ({ name }: { name: string }) =>
        `Retiring puts ${name} to sleep for good. Its threads stay readable in the Archive.`,
      retire: ({ name }: { name: string }) => `Retire ${name}…`,
      retiringLine: ({ name }: { name: string }) =>
        `${name} is finishing its open Tasks, then retires. It takes no new work meanwhile.`,
      retireNow: ({ name }: { name: string }) => `Retire ${name} now…`,
    },
    retire: {
      title: ({ name }: { name: string }) => `Retire ${name}?`,
      busy: ({ name }: { name: string }) => `${name} is writing a reply right now. What should happen to it?`,
      idle: ({ name }: { name: string }) => `${name} stops working and goes to sleep. Nothing is deleted.`,
      open: ({ name }: { name: string }) => `${name} still has work open. What should happen to it?`,
      unread: ({ name }: { name: string }) => `Hobbots could not read ${name}'s open work. Close and try again.`,
      runningHeading: "Writing now",
      tasksHeading: ({ count }: { count: number }) => (count === 1 ? "1 open Task" : `${count} open Tasks`),
      waitingOn: ({ approvals, items }: { approvals: number; items: number }) =>
        [
          ...(approvals > 0 ? [approvals === 1 ? "1 approval waits" : `${approvals} approvals wait`] : []),
          ...(items > 0 ? [items === 1 ? "1 item in its backpack" : `${items} items in its backpack`] : []),
        ].join(" · "),
      handTo: "Hand them to",
      pickTaker: "Pick a hob",
      noTaker: "No other hob takes new work right now, so there is nobody to hand the Tasks to.",
      cannotTake: ({ taker, count }: { taker: string; count: number }) =>
        `${taker} cannot take ${count === 1 ? "one of these Tasks" : `${count} of these Tasks`}. Pick another hob, or let it finish first.`,
      choices: ({ name }: { name: string }) => `What happens to ${name}'s work`,
      kept: "Its threads are kept and stay readable. Retiring can't be undone, but you can summon a new hob any time.",
      failed: ({ name }: { name: string }) => `Hobbots could not retire ${name}. Try again.`,
      keep: ({ name }: { name: string }) => `Keep ${name}`,
      confirm: ({ name }: { name: string }) => `Retire ${name}`,
      retiring: "Retiring…",
      done: ({ name }: { name: string }) => `${name} is asleep`,
      waiting: ({ name }: { name: string }) => `${name} retires when done`,
      whenDone: ({ name }: { name: string }) => `${name} then goes to the Archive, under Retired hobs.`,
      close: "Close",
      find: ({ name }: { name: string }) => `You find ${name} in the Archive, under Retired hobs.`,
      archived: "Open the Archive",
      home: "Go to Home",
    },
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
      note: "The new name shows everywhere, past chats included. Other hobs learn it from its next reply.",
    },
  },
  summon: {
    checkAgain: "Check again",
    checking: "Checking…",
    checkingProviders: "Checking your AI providers",
    checkFailed: "Hobbots could not check your AI providers.",
    /** The wait line while the providers are checked, after a second. */
    waitingProviders: "Checking your AI providers…",
    /** After ten seconds of checking. */
    checkSlow: "Your AI providers are slow to answer. Your hobs keep working.",
    tryAgain: "Try again",
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
    peekLabel: ({ name, role, state }: { name: string; role: string; state: string }) => `${name}, ${role}, ${state}`,
    peekResting: "Nothing on right now.",
    openChat: "Open chat",
    openWorkbench: "Open Workbench",
    hall: {
      tag: ({ count }: { count: number }) => `+${formatCount(count)} in the hall`,
      open: ({ count }: { count: number }) =>
        pluralForm(count, {
          one: "Open Your hobs: 1 more hob waits in the hall",
          other: `Open Your hobs: ${formatCount(count)} more hobs wait in the hall`,
        }),
    },
    chips: {
      label: "Show hobs",
      all: "All",
      needs: "Need you",
      working: "Working",
      resting: "Resting",
    },
    landmark: "Your hobs right now",
    summon: "+ Summon a hob",
  },
  search: {
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
    landmark: "Chat",
    /** The transcript's scrolling area, which takes the keyboard focus so it scrolls from the keyboard. */
    transcript: "Messages",
    editHob: "Edit hob",
    ideas: ["Plan a product launch", "Sum up this week's inbox", "Tidy my Downloads folder"],
    askWhat: "What are we making?",
    newThread: "New thread",
    openHob: ({ name }: { name: string }) => `Open ${name}'s page`,
    /** The back arrow at the start of the chat header, which opens the hob's page on its chats. */
    backToChats: ({ name }: { name: string }) => `Back to ${name}'s chats`,
    /** After the hob's name under the chat title: the hob leads this chat, and what it is doing now. */
    leadLine: ({ doing }: { doing: string }) => ` · lead · ${doing}`,
    /** What the hob does while its reply waits only on commands it started (#1056). */
    waitingOn: ({ command, time }: { command: string; time: string }) => `waiting on ${command} · ${time}`,
    waitingOnMany: ({ count, time }: { count: number; time: string }) =>
      `waiting on ${formatCount(count)} commands · ${time}`,
    hello: ({ name }: { name: string }) => `Hello, I'm ${name}!`,
    freshPage: "A fresh page",
    helloBody: "Tell me my first chore. I keep working even if you switch to another thread.",
    freshBody: ({ name }: { name: string }) =>
      `Tell ${name} what you want done. ${name} plans it, brings in other hobs when it needs them, and asks you before anything risky.`,
    waiting: "Waiting to send",
    waitingRefused: "✗ Not sent yet. It stays here until you try again or edit it.",
    waitingSending: "◷ Sending…",
    waitingOffline: "◷ Waiting to send. It goes out when we reconnect.",
    edit: "Edit",
    tryAgain: "Try again",
    brainUnavailable: "Brain unavailable",
    continueFailed: ({ name, why }: { name: string; why: string }) => `${name} could not continue that reply. ${why}`,
    queueGone: "That message already started or was removed.",
    stopWaitingFailed: ({ name, command }: { name: string; command: string }) =>
      `Hobbots could not stop waiting, so ${command} still runs and ${name}'s reply still waits on it. Press Stop waiting to try again.`,
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
    /** Send's name while a reply runs: what you send now goes once it ends. */
    sendAfterReply: "Send after this reply",
    /** The one-line hint while a reply runs; beside the Quest room it keeps only the short one. */
    hintReplying: ({ name }: { name: string }) => `${name} is replying`,
    hintReplyingShort: "Replying",
    hintSendsAfter: "Sends after this reply",
    hintStopping: ({ name }: { name: string }) => `Stopping. What ${name} wrote so far is kept.`,
    hintStoppingShort: "Stopping",
    /**
     * Once the hob has answered and the reply only waits on commands it started (#1056): what it
     * waits on and for how long, in one line, with the short one beside the Quest room.
     */
    hintWaiting: ({ name, command, time }: { name: string; command: string; time: string }) =>
      `${name} is waiting on ${command} · ${time}`,
    hintWaitingMany: ({ name, count, time }: { name: string; count: number; time: string }) =>
      `${name} is waiting on ${formatCount(count)} commands · ${time}`,
    /** After a long wait, said after the hint in the same quiet color. */
    hintWaitingLong: "It may not end on its own.",
    hintWaitingShort: ({ time }: { time: string }) => `Waiting · ${time}`,
    hintSendsWhenEnds: ({ command }: { command: string }) => `Sends when ${command} ends`,
    hintSendsWhenAllEnd: "Sends when the commands end",
    hintStoppingWait: ({ name, command }: { name: string; command: string }) =>
      `Stopping ${command}. ${name}'s reply is kept.`,
    hintStoppingWaitMany: ({ name }: { name: string }) => `Stopping the commands. ${name}'s reply is kept.`,
    minutes: ({ count }: { count: number }) => (count < 1 ? "under a minute" : `${formatCount(count)} min`),
    stopWaiting: "■ Stop waiting",
    stopWaitingDescription: ({ name, command }: { name: string; command: string }) =>
      `Stop waiting ends this reply now. What ${name} wrote is kept, and ${command} is stopped. Messages you send now wait their turn.`,
    theCommands: "the commands",
    /** Stop's description, read by screen readers and shown on hover. */
    stopDescription: ({ name }: { name: string }) =>
      `Stop ends this reply only. What ${name} wrote so far is kept. Messages you send now wait their turn.`,
    hintPausedQueue: ({ name }: { name: string }) =>
      `${name} is paused. Messages you queue wait until you wake ${name}.`,
    hintPausedNew: ({ name }: { name: string }) =>
      `Paused hobs take no new work. Your draft stays here until you wake ${name}.`,
    hint: "Enter sends · Shift+Enter adds a line · ↑ brings back your last message",
  },
  reply: {
    /** Over your message: who sent it and when. */
    you: ({ time }: { time: string }) => `You · ${time}`,
    /** The tag beside the name on a reply: the thread's hob leads its work. */
    lead: "Lead",
    thinking: ({ name }: { name: string }) => `${name} is thinking`,
    writing: "writing…",
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
    change: "Change brain",
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
    /** The tag on a message sent while a reply runs, above the composer until it starts. */
    waitsItsTurn: "Waits its turn",
    /** Why a message sent while the reply waits on a command waits (#1056). */
    waitsForCommand: ({ command }: { command: string }) => `Goes when ${command} ends, or when you stop waiting.`,
    waitsForCommands: "Goes when the commands end, or when you stop waiting.",
    waitsForWake: ({ name }: { name: string }) => `Waits until you wake ${name}`,
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
      stopped: "stopped by you",
    },
    /** What a screen reader hears after a running command the reply waits on (#1056). */
    waitedOutcome: "the reply waits for it to end",
    running: ({ label }: { label: string }) => `${label}…`,
    waitingOn: ({ command }: { command: string }) => `Waiting on ${command}`,
    waitingNote: ({ time }: { time: string }) =>
      `Running for ${time}. The reply ends when it does, or when you stop waiting.`,
    stopped: ({ time }: { time: string | null }) =>
      time === null
        ? "Stopped by you while the reply waited on it."
        : `Stopped by you after ${time}, while the reply waited on it.`,
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
    targetLine: ({ target }: { target: string }) => `On: ${target}`,
    askedByLine: ({ chain }: { chain: string }) => `Asked by: ${chain}`,
    riskLine: ({ risk }: { risk: string }) => `Risk: ${risk}`,
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
    /**
     * Always, named for what its rules cover: the folder, the files, the command, the branch, the
     * repository or the site. Plain Always when the rules cover more than one kind of thing.
     */
    always: {
      folder: "Always for this folder",
      folders: "Always for these folders",
      file: "Always for this file",
      files: "Always for these files",
      command: "Always for this command",
      commands: "Always for these commands",
      branch: "Always for this branch",
      repository: "Always for this repository",
      site: "Always for this site",
      host: "Always for this host",
      mixed: "Always",
    },
    alwaysIntro: ({ name }: { name: string }) =>
      `Hobbots saves this rule, and ${name} stops asking for what it covers. You can remove it later.`,
    /** The middle lifetime (ADR 018): This Task, or This Quest once a party joins the Task. */
    forWork: { task: "This task", quest: "This quest" },
    forWorkIntro: {
      task: ({ name }: { name: string }) =>
        `Hobbots saves this rule for this task only. ${name} stops asking for what it covers, in every step, until the task ends.`,
      quest: ({ name }: { name: string }) =>
        `Hobbots saves this rule for this quest only. ${name} stops asking for what it covers until the quest ends. Other hobs on the quest still ask.`,
    },
    saveForWork: { task: "Save for this task and allow", quest: "Save for this quest and allow" },
    /** A rule in words, by how long it lasts. */
    ruleFor: {
      always: ({ rule }: { rule: string }) => `Always ${rule}`,
      task: ({ rule }: { rule: string }) => `For this task, ${rule}`,
      quest: ({ rule }: { rule: string }) => `For this quest, ${rule}`,
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
      charm: ({ name, operation, site }: { name: string; operation: string; site: string }) =>
        site === "" ? `let ${name} use ${operation}` : `let ${name} use ${operation} for ${site}`,
      runner: ({ name, command, file }: { name: string; command: string; file: string }) =>
        `${command} runs what this folder's ${file} says. If ${name} changes that file, the rule runs the new version.`,
    },
    highRisk: "High risk · once only",
    highRiskUndone: "High risk · once only · it cannot be undone",
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
      `✓ Allowed for the rest of this task. ${name} carries on, and asks again once the task ends.`,
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
      "github.read": "Reads only. Nothing changes.",
      "github.open-pull-request": "Opens a pull request others can see at once. You can close or edit it.",
      "github.comment": "Posts a comment others can see at once. You can edit or delete it.",
      "outside-folders": "Acts outside the folders this hob may use.",
      "search-memory": "Reads only. Nothing changes.",
      "save-memory": "Writes a page to its own memory. You can edit or undo it.",
      "search-skills": "Reads only. Nothing changes.",
      "request-skill": "Gives it a skill from your library. You can undo it.",
      "propose-skill": "Drafts a skill. Nothing changes until you add it.",
      "skill-feedback": "Leaves a note on a skill. Nothing changes.",
      "read-hobs": "Reads only. Nothing changes.",
      "search-web": "Sends the search to its AI's provider. Nothing changes.",
    },
  },
  charms: {
    intro: ({ name }: { name: string }) =>
      `Charms connect ${name} to other apps. You connect each app once in Settings, then choose here what ${name} may do with it.`,
    more: "More Charms show up here as Hobbots adds them. You connect each one once in Settings.",
    moreLink: "Charms in Settings",
    github: {
      name: "GitHub",
      card: "GitHub Charm",
      checking: "Checking GitHub…",
      slow: "GitHub is slow to answer. Your hobs keep working.",
      retry: "Try again",
      state: {
        off: "Off",
        on: "On",
        "as-you": "On · as you",
        "not-ready": "Not ready",
        "cannot-act": "Can't act",
      },
      mayDo: ({ name }: { name: string }) => `What ${name} may do`,
      rulesNote: "Ask puts the step in your Inbox first. These never go past your safety level.",
      actions: {
        "github.read": {
          label: "Read code",
          note: "Repository details, issues and pull requests of its folders, read on the hub.",
        },
        push: { label: "Push changes", note: "Send its commits to a remote." },
        "github.open-pull-request": {
          label: "Open pull requests",
          note: "From its pushed branches, in the repository of its folders.",
        },
        "github.comment": {
          label: "Comment and reply",
          note: "Comments on issues and pull requests in the repository of its folders.",
        },
      },
      reads: ({ name }: { name: string }) =>
        `Reads, pushes to, opens pull requests in and comments on the repository of ${name}'s folders, as you. The hub reaches GitHub with the account you connected in Settings, so no key reaches ${name}.`,
      readsAsBot: ({ name, bot }: { name: string; bot: string }) =>
        `Reads, pushes to, opens pull requests in and comments on the repository of ${name}'s folders, as ${bot}. The hub keeps the app's key, so no key reaches ${name}.`,
      grant: ({ name }: { name: string }) => `Let ${name} use GitHub`,
      off: ({ name }: { name: string }) =>
        `${name} can't use GitHub. Turn it back on and its rules and its app are as you left them.`,
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
        you: "You",
        youAs: ({ login }: { login: string }) => `You, @${login}`,
        give: ({ name }: { name: string }) => `Give ${name} its own GitHub app`,
        makeApp: "Make its app",
        giveNote: ({ name }: { name: string }) =>
          `GitHub opens in your browser, where you name the app and pick its repositories. ${name}'s work then shows on GitHub as its own bot, never as you.`,
        noKeychain: "This hub has no keychain Hobbots can use, so it cannot keep a hob's own GitHub app.",
        finishOnGitHub: ({ name }: { name: string }) =>
          `Finish on GitHub, in the browser that just opened. This updates by itself once ${name}'s app is made.`,
        openAgain: "Open GitHub again",
        restartNote:
          "Each start works once. If GitHub said the app was not kept, or the page stopped working, start again.",
        restart: "Start again",
        expired: "The last start ran out before the app was made. Start again when you're ready.",
        startFailed: "Hobbots could not start making the app. Try again.",
        ownApp: "its own app",
        made: ({ since }: { since: string }) => `Made ${since}. Its work never runs as you.`,
        cannotAct: "Can't act",
        installTitle: "One more step: install it",
        installedLabel: "Installed on",
        installation: ({ account, all }: { account: string; all: boolean }) =>
          all ? `@${account}: every repository` : `@${account}: the repositories you picked`,
        suspended: "suspended",
        change: "Change on GitHub",
        reaches: ({ account }: { account: string }) => `Repositories @${account} lets it reach`,
        noRepositories: "No repositories yet",
        moreRepositories: ({ count }: { count: number }) => `and ${count} more`,
        notInstalled: ({ name }: { name: string }) =>
          `Not installed on any repository yet, so ${name} can't act on GitHub. Pick the repositories it should reach.`,
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
        disconnectAsk: "Disconnect its app…",
        keep: "Keep it",
        confirmDisconnect: ({ name }: { name: string }) =>
          `Disconnect ${name}'s app? The hub removes it from your repositories and deletes its key. ${name} then acts as you again.`,
        cancel: "Cancel",
        disconnected: ({ name }: { name: string }) =>
          `Disconnected. ${name} acts as you again. The app itself stays on GitHub until you delete it there.`,
        deleteOnGitHub: "Delete the app on GitHub",
        leftOverTitle: ({ name }: { name: string }) => `${name}'s old app was not fully removed`,
        leftOver: "It no longer acts.",
        dismiss: "Dismiss",
        changeFailed: "Hobbots could not change the app. Try again.",
        // An app the user already has, linked by its ID and private key (#1321).
        useExisting: "Use an app you already have…",
        linkTitle: "Link an app you already have",
        linkNote: ({ name }: { name: string }) =>
          `In the app's settings on GitHub, copy its Client ID and generate a private key. The key stays in this computer's keychain, never with ${name}, and the app keeps its installations.`,
        openApps: "Open your apps on GitHub",
        linkOnHub: ({ name }: { name: string }) =>
          `To give ${name} an app you already have, open this page on the hub's computer, so the app's private key never leaves it.`,
        appIdLabel: "Client ID",
        appIdHint: "Or its App ID. GitHub shows both in the app's settings.",
        keyLabel: "Private key",
        keyHint: "Paste the whole .pem file GitHub downloaded, or choose it.",
        chooseKey: "Choose the .pem file",
        linkApp: "Link the app",
        linking: "Checking with GitHub…",
        appIdMissing: "Give the Client ID or App ID from the app's settings on GitHub.",
        keyMissing: "Paste the private key GitHub gave you, from -----BEGIN to the end.",
        keyTooLarge: "That file is too large to be a GitHub app private key.",
        linkRefused: {
          retired: ({ name }: { name: string }) => `${name} is retired, so it cannot get an app.`,
          connected: ({ name }: { name: string }) => `${name} already has its own app. Disconnect it first.`,
          "left-over": ({ name }: { name: string }) =>
            `${name}'s old app was not fully removed. Delete it on GitHub or dismiss it first.`,
          "no-keychain": () => "This hub has no keychain Hobbots can use, so it cannot keep the app's key.",
          "not-local": () => "Link the app from the hub's own computer, so its private key never leaves it.",
          "bad-id": () => "That is not a Client ID or App ID. Copy it from the app's settings on GitHub.",
          "not-a-key": () => "That is not a GitHub app private key. Paste the whole .pem file.",
          "key-refused": () =>
            "GitHub did not accept this key for that app. Check the App ID, or generate a new private key on GitHub.",
          taken: () => "That app is already another hob's. One app is one hob's name.",
          unreachable: () => "Hobbots could not check the app with GitHub. Try again.",
          "keychain-failed": () => "The keychain did not keep the app's key. Unlock it, then try again.",
        },
        linkFailed: "Hobbots could not link the app. Try again.",
        linked: ({ since }: { since: string }) => `Linked ${since}. Its work never runs as you.`,
        missingPermissions: ({ name, list }: { name: string; list: string }) =>
          `The app lacks permissions ${name}'s GitHub actions use: ${list}. Add them in the app's settings on GitHub, then accept them on its installation. Until then those actions fail.`,
        permissionNames: {
          metadata: "Metadata",
          contents: "Contents",
          issues: "Issues",
          pull_requests: "Pull requests",
          checks: "Checks",
          actions: "Actions",
          statuses: "Commit statuses",
          workflows: "Workflows",
        },
        permissionAccess: ({ name, access }: { name: string; access: "read" | "write" }) =>
          access === "read" ? `${name} (read)` : `${name} (read and write)`,
        reconnectLinkedKey: ({ name }: { name: string }) =>
          `GitHub no longer accepts the app's key: it was revoked, or the app was deleted. ${name}'s GitHub actions fail until you link the app again with a new key. They never run as you instead.`,
        linkAgain: "Link it again",
        unlink: "Unlink",
        unlinkAsk: "Unlink its app…",
        confirmUnlink: ({ name }: { name: string }) =>
          `Unlink ${name}'s app? The hub deletes its key here. The app and its installations stay on GitHub as they are. ${name} then acts as you again.`,
        unlinked: ({ name }: { name: string }) =>
          `Unlinked. ${name} acts as you again. The app stays on GitHub as it was.`,
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
    waiting: "Asking Tailscale…",
    slow: "Tailscale is slow to answer. Your hobs keep working.",
    tryAgain: "Try again",
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
      remove: "Remove",
      removeLabel: ({ name }: { name: string }) => `Remove ${name}`,
      confirm: ({ name }: { name: string }) => `Remove ${name}? It is signed out now and has to ask again.`,
      keep: "Keep",
      confirmRemove: "Remove",
      removing: "Removing…",
      failed: "Hobbots could not read your devices. Try again in a moment.",
      removeFailed: "Hobbots could not remove it. Try again in a moment.",
      revokedByRestore: "Revoked by a restore",
      pairAgain: "Open Hobbots on that device to ask again.",
      footer:
        "Each new device asks once, here and with a notification. A removed device is signed out right away and has to ask again.",
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
    speech: "Hello, I'm the Chief. First things first: your hobs need one home computer. This one?",
    caption: "This computer becomes the hub",
    title: "Where should your hobs live?",
    intro:
      "Hobs live on one computer, your hub. It keeps working in the background, even with the window closed. Your other devices can visit it.",
    legend: "Where Hobbots runs",
    here: {
      title: "This computer",
      body: "This computer becomes the hub. Hobs, chats and files live here, and hobs work with its folders and apps.",
      badge: "Most people start here",
    },
    connect: {
      title: "Another computer",
      body: "Already have a hub? Use it from here with chat, quests, approvals and the Workbench.",
      onHub: "This computer is the hub already. To use it from another computer, open Hobbots there and choose this.",
    },
    starting: "Starting Hobbots…",
    startFailed: "Hobbots could not start here. Try again in a moment.",
  },
  welcome: {
    getStarted: "Get started",
    alreadyUse: "I already use Hobbots",
    saveFailed: "Hobbots could not save that. Try again in a moment.",
    tagline: "Little helpers that work on your computer, with the AI you already use.",
    duration: "About 3 minutes. Everything stays on your computer.",
    chiefHello: "Welcome! I'm the Chief. I'll help you set up your first hob.",
    worksWith: ({ providers }: { providers: string }) => `Works with ${providers}`,
    sayHi: ({ name }: { name: string }) => `Say hi to ${name}`,
  },
  remoteSetup: {
    stepNumber: ({ n }: { n: number }) => `${n}.`,
    title: "Use Hobbots on your phone too?",
    intro:
      "Open your hobs from your laptop or phone, over your own private network. Nothing is open to the internet. You can skip this and turn it on later.",
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
    captionOff: "Only this computer, for now",
    captionOn: "Your phone can visit",
    elder: {
      on: "Lovely. Your phone can visit now. It asks you once, the first time.",
      ready: "Want your hobs on your phone too? This part is optional.",
      missing: "Tailscale is not ready on this computer yet. You can skip this and turn it on later in Settings.",
    },
  },
  deviceAccess: {
    removedTitle: ({ hub }: { hub: string }) => `This device was removed from ${hub}`,
    removedTitleNoName: "This device was removed from the hub",
    removedBody:
      "Someone revoked it, so it can no longer reach your hobs. Ask again, then allow it on the hub, to use Hobbots here.",
    askAgain: "Ask again",
    reconnecting: "Reconnecting to Hobbots… Your hobs keep working on the hub; messages wait here until it is back.",
    unreachable: ({ hub }: { hub: string }) =>
      `Hobbots cannot reach ${hub}. The hub may be off, or remote access may be paused. Messages you send wait here.`,
    unreachableNoName:
      "Hobbots cannot reach the hub. It may be off, or remote access may be paused. Messages you send wait here.",
    tryNow: "Try now",
  },
  hubReads: {
    failed:
      "Hobbots could not read what your hobs and Quests are doing, so they may show as resting or with no progress. Your hobs keep working on the hub.",
    tryAgain: "Try again",
    tryingAgain: "Trying again…",
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
  permissions: {
    loadFailed: ({ name }: { name: string }) => `Hobbots could not read what ${name} may do.`,
    tryAgain: "Try again",
    noShared: "No shared folders yet.",
    addInSettings: "Add them in Settings",
    sharedFolders: "Shared folders",
    intro: ({ name, preset }: { name: string; preset: string }) =>
      `${name} follows your safety level, ${preset}. Here you can make ${name} more careful than that, never less.`,
    careful: ({ count, preset }: { count: number; preset: string }) =>
      count === 0
        ? `Same as ${preset}`
        : pluralForm(count, {
            one: `1 rule is more careful than ${preset}`,
            other: `${count} rules are more careful than ${preset}`,
          }),
    changeSafety: "Change safety level",
    groups: {
      files: "Files",
      memory: "Memory",
      skills: "Skills",
      hobs: "Other hobs",
      commands: "Commands",
      web: "Web",
      outside: "Outside its folders",
    },
    checked: "Checked",
    checkedHint: "Hobbots decides this rule, but a command the hob may run could still do it another way.",
    commands: {
      "read-only":
        "Read-only while Change files is Never: its commands can look at its folders, show Git's status, diff and log and run tests, but cannot write there, .git included, so they cannot commit.",
      closed:
        "Closed while Look at files is not Allow or Change files is Ask, since a command reads and writes without asking. Pick Allow, or Never on Change files for read-only commands.",
    },
    moreCareful: "More careful",
    reset: ({ preset, answer }: { preset: string; answer: string }) => `${preset} says ${answer} · reset`,
    wider: "Wider than your safety level allows. Change it in Settings › Safety.",
    widens: ({ preset }: { preset: string }) =>
      `That answer allows more than your ${preset} safety. Pick a narrower one.`,
    saveFailed: ({ name }: { name: string }) => `Hobbots could not save ${name}'s permissions. Try again in a moment.`,
    folders: ({ name }: { name: string }) => `Folders ${name} can use`,
    ownFolders: ({ name }: { name: string }) => `${name}'s own folders`,
    noOwnFolders: ({ name }: { name: string }) => `None yet. Only ${name} can work in a folder added here.`,
    sharedNote: "Shared folders are set in Settings › Safety and every hob can use them.",
    sandbox: "Sandbox",
    details: "Details: how these rules are kept",
    detailsNote: ({ name }: { name: string }) =>
      `Hobbots decides each rule before every step ${name} takes. Commands, Git and the web also run inside its sandbox, which keeps ${name} in its folders. A rule marked Checked is decided by Hobbots, but a command ${name} may run could still do it another way. Memory rules are decided by Hobbots each time ${name} uses its memory tools: on Never, it cannot search its memory or save to it. Even then, each new session still starts with a short brief from the memory ${name} reads, and Hobbots still keeps a summary of each chat in ${name}'s own memory. Skill rules work the same way: a skill itself grants nothing, and its scripts run under the rules above. Search the web is Allow or Never only, because Codex runs its search inside the AI's turn and cannot pause for you.`,
    /** Search the web's note, by the runtime the hob thinks with (ADR 036). */
    searchWeb: {
      "claude-code": "Look things up with Claude Code's search. The query goes to Anthropic, who runs the search.",
      codex:
        "Look things up with Codex's search, from OpenAI's cached index. The query goes to OpenAI, who runs the search.",
      notOffered:
        "Look things up and bring back links. The AI this hob thinks with has no search Hobbots can check, so it is off.",
    },
    notOffered: "Not offered on this AI",
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
      webSearch: "Its own web search",
    },
    status: { verified: "Verified", unverified: "Not verified", unsupported: "Unsupported" },
    needsSandbox: "Needs the sandbox",
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
  generalSettings: {
    openAtLogin: "Open Hobbots at login",
    openAtLoginNote: "Starts in the background, without the window, so hobs keep working after a restart.",
    openLoginItems: "Open Login Items",
    loginItemFailed:
      "Hobbots could not read or change its login item. Try again, or check System Settings › General › Login Items.",
    keepRunning: "Keep running in the menu bar when the window closes",
    keepRunningNote: "Hobs keep working after you close the window. Reopen it from the menu-bar icon.",
    closeQuits:
      "Closing the window will quit Hobbots. Hobs stop what they are doing, and their work is picked up again as interrupted next time. If hobs are busy, Hobbots asks before quitting.",
    keepRunningFailed: "Hobbots could not read or change this setting. Try again.",
    quitStopsServer: "Quitting Hobbots from the menu-bar icon or with ⌘Q stops the server it started either way.",
    desktopOnly: "Open at login and the menu bar are set in the Hobbots app on the Mac that runs your hub.",
  },
  safety: {
    recommended: "Recommended",
    changeLater: "You can change this in Settings › Safety, and make any single hob more careful in its profile.",
    presetFailed: "Hobbots could not save the safety preset. Try again in a moment.",
    presetRules: ({ preset }: { preset: string }) => `With ${preset}, a hob will`,
    later: "Later",
    remove: "Remove",
    removeFolder: ({ folder }: { folder: string }) => `Remove ${folder}`,
    chooseFolder: "+ Choose a folder…",
    pathLabel: "Folder path on the hub",
    pathPlaceholder: "~/Documents or /Users/you/code",
    addFolder: "Add folder",
    pathNote: "Type the path of a folder on the computer that runs your hub.",
    foldersFailed: "Hobbots could not save the folders. Try again in a moment.",
  },
  hobForm: {
    choresPlaceholder: "Tell it about the chores, like you would tell a friend who is helping out.",
    goodAt: "Good at",
    goodAtPlaceholder: "Like “Planting calendars and watering reminders”",
    goodAtNote:
      "Other hobs read this to know when to come to this hob. It never changes how it behaves. Every hob can see it, so keep anything private out.",
    goodAtFilled: "Filled in from the chores and the role until you change it.",
    ownTitle: "Your own role title",
    ownTitlePlaceholder: "Its role, in your words. e.g. Garden planner",
    sigil: "Sigil",
    roleSigil: ({ role }: { role: string }) => `${role}'s sigil`,
    model: "Model",
  },
  tone: {
    voice: "Voice",
    wordingOnly: "Changes wording only",
    themedNote: ({ name }: { name: string }) =>
      `Facts stay as accurate as ever. Code, commands, links and warnings stay plain, and ${name} drops the voice when things get serious.`,
    length: "Length",
  },
} as const;
