import type { SkillCheck, SkillDroppedKind } from "@hobbots/domain";
import { formatBytes, formatCount, formatDay, formatList, plural } from "../../lib/format.ts";

const skills = (count: number) => `${formatCount(count)} ${plural(count, { one: "skill", other: "skills" })}`;
const files = (count: number) => `${formatCount(count)} ${plural(count, { one: "file", other: "files" })}`;

/** User-facing copy for the Skills page (STD-I18N-001). */
export const messages = {
  title: "Skills",
  head: {
    loading: "Opening your skills…",
    empty: "No skills yet",
    full: ({ count, revisions }: { count: number; revisions: number }) =>
      `${skills(count)} · ${formatCount(revisions)} ${plural(revisions, { one: "revision", other: "revisions" })}`,
    failed: "Not answering",
  },
  search: {
    label: "Search skills",
    placeholder: "Search skills by name or what they do",
    clear: "Clear the search",
    some: ({ count, q }: { count: number; q: string }) =>
      `${formatCount(count)} ${plural(count, { one: "skill matches", other: "skills match" })} “${q}”`,
    none: ({ q }: { q: string }) => `No skill matches “${q}”`,
  },
  add: "Add a skill",
  nav: {
    label: "Skill scopes",
    overview: "Overview",
    review: "To review",
    updates: "Updates",
    changes: "What changed",
    shared: "Shared",
    hobs: "Hobs",
  },
  overview: {
    library: "Your library",
    libraryHint: "Hobs load a skill only once it is given to them",
    note: "Hobs get only what is here. Skills, plugins and MCP servers you installed in your own Claude Code or Codex stay out of Hobbots. Skills in ~/.agents/skills show up here by themselves.",
    worth: "Worth a look",
    agentsProblem: ({ folder }: { folder: string }) => `${folder} in ~/.agents/skills was not added`,
    agentsUnreadable: "~/.agents/skills could not be read",
    flagged: ({ name }: { name: string }) => `${name} has something to look at`,
    flaggedHint: "A script, a link or hidden text. Open it to see where.",
    updated: ({ when }: { when: string }) => `Changed ${when}`,
    export: "Export…",
  },
  trial: {
    button: "Try in a chat",
    starting: "Opening a chat…",
    menu: "Try it with",
    hint: "Opens a new chat where only this draft is loaded. Nothing reaches the library.",
    noHobs: "No hob is awake to try it with.",
    loadingHobs: "Reading your hobs…",
    hobsFailed: "Hobbots could not read your hobs.",
    tryAgain: "Try again",
    refused: ({ message }: { message: string }) => `This draft cannot load as it is: ${message}`,
    gone: "That proposal or revision is no longer here.",
    hobGone: "That hob cannot take a new chat now.",
    failed: "Hobbots could not open the chat. Try again.",
    notice: ({ name }: { name: string }) => `Trying the draft of ${name}.`,
    noticeHint: "Only this draft is loaded in this chat, and nothing here reaches the library or counts as a use.",
    backToDraft: "Back to the draft",
    draftGone:
      "The draft this chat tries is no longer on this hub, as after a restore, so nothing runs here. Try in a chat again from where you wrote it.",
    editorGone: "The draft you tried is no longer on this hub, as after a restore, so this opens without it.",
    loadingDraft: "Opening the draft you tried…",
  },
  health: {
    aHob: "A hob",
    unused: ({ name, days }: { name: string; days: number }) => `${name} was not used in ${formatCount(days)} days`,
    neverUsed: ({ name }: { name: string }) => `${name} was never used`,
    unusedHint: ({ count }: { count: number }) =>
      `${formatCount(count)} ${plural(count, { one: "place gets", other: "places get" })} it, so those hobs read its description before each chat. Take it off where nobody needs it.`,
    behind: ({ who, name, rev }: { who: string; name: string; rev: string }) => `${who} is on ${name} ${rev}`,
    behindHint: ({ latest, held }: { latest: string; held: boolean }) =>
      held
        ? `Kept there while ${latest} is the newest. Move it when you are ready.`
        : `${latest} is the newest. Move it there.`,
    behindLost: ({ who, name }: { who: string; name: string }) => `${who} is on a revision of ${name} the library lost`,
    clashProjects: ({ hob, name }: { hob: string; name: string }) => `Two of ${hob}'s projects have a “${name}”`,
    clashProjectsHint: "Neither loads for it until you keep one.",
    clashReplaced: ({ hob, name }: { hob: string; name: string }) => `${hob} gets two skills named “${name}”`,
    clashReplacedHint: "The narrower one replaces the other for it. Keep both, or remove one.",
    clashSame: ({ hob, name }: { hob: string; name: string }) => `${hob} loads two skills named “${name}”`,
    clashSameHint: "Both load, so /name picks neither. Rename one, or give only one.",
    vague: ({ name }: { name: string }) => `${name}'s description may not trigger`,
    vagueHint: "Say which requests it is for, such as “Use when…”, so a hob picks it on its own.",
    long: ({ name, length }: { name: string; length: number }) =>
      `${name}'s description is long (${formatCount(length)} characters)`,
    longHint: "Every hob that has it reads it before each chat. Keep it to when to use it.",
    allGood: "Nothing needs a look.",
    loading: "Checking your skills…",
    failed: "Hobbots could not check your skills.",
    retry: "Try again",
    carries: "What each hob carries",
    load: ({ count, percent }: { count: number; percent: number }) =>
      `${formatCount(count)} · ${formatCount(percent)}%`,
    /** Read after the hob's name, in place of the bar and the figures. */
    loadLabel: ({ count, percent }: { count: number; percent: number }) =>
      ` carries ${skills(count)}, ${formatCount(percent)}% of its listing`,
    loadHint:
      "A hob reads every skill's name and description before each chat, within about 8,000 characters. Past that, or past about 30 skills, it picks the right one less often.",
    noHobs: "No hob has skills yet.",
    more: ({ count }: { count: number }) => `Show ${formatCount(count)} more`,
    fewer: "Show fewer",
  },
  export: {
    title: "Export skills",
    intro:
      "Makes a folder with each skill and a skills.lock.json that names its source and revision, so another hub gets exactly the same ones. Backups already include your whole library, except skills in ~/.agents/skills.",
    list: "Skills to export",
    pick: ({ name }: { name: string }) => `Export ${name}`,
    more: ({ name, count }: { name: string; count: number }) => `${name} +${formatCount(count)}`,
    notExported: "Not exported",
    notExportedScope: "Everyone · ~/.agents",
    notExportedNote:
      "Skills in ~/.agents/skills stay in that folder. Another computer's Hobbots reads its own ~/.agents/skills. Make a copy first if you want to take one with you.",
    assignments: "Include who gets each skill",
    assignmentsHint:
      "Keeps Everyone, project and hob assignments, and held revisions. A hub without those hobs or projects keeps the skills in its library only.",
    exportN: ({ count }: { count: number }) => (count === 0 ? "Pick a skill to export" : `Export ${skills(count)}`),
    exporting: "Exporting…",
    cancel: "Cancel",
    importHint: "Import it on another hub with Add a skill › Folder or .zip",
    saved: ({ name, where, count }: { name: string; where: string; count: number }) =>
      `Saved ${name} to ${where}: ${skills(count)} and skills.lock.json.`,
    failed: "Nothing was exported. Try again.",
    insideHob:
      "Your Downloads folder is inside a folder hobs work in, so Hobbots did not save the export there. Move that hob's folder, then try again.",
  },
  scopes: {
    everyone: "Everyone",
    everyoneHint: "Every hob, and every hob you summon later",
    project: ({ name }: { name: string }) => `${name} project`,
    projectHint: "Hobs working in its folders",
    hobHint: "Only this hob",
    projectKind: "Project",
    hobKind: "Hob",
    none: "Not given to anyone yet",
    noneHint: "In your library only",
    formerHob: "A retired hob",
  },
  source: {
    written: "Written in Hobbots",
    agents: "~/.agents/skills",
    unknown: "From a source",
  },
  chips: {
    agents: "From ~/.agents",
    held: ({ rev }: { rev: string }) => `Kept on ${rev}`,
    heldOld: "Kept on an older revision",
    older: "On an older revision",
    onlyWhenAsked: "Only when asked",
    updateAvailable: "Update available",
    updatesAutomatically: "Updates automatically",
    set: ({ count }: { count: number }) => `Set of ${skills(count)}`,
  },
  review: {
    title: "To review",
    intro:
      "A new skill or a change to one always waits for you, whatever the safety level. Each also shows in your Inbox.",
    empty: "Nothing to review. When a hob drafts a skill or suggests a change to one, it waits here.",
    listLabel: "Skills that wait for you",
    newSkill: "New skill",
    change: "Change",
    from: ({ who }: { who: string }) => `${who}, from a chat`,
    fromMemory: ({ who }: { who: string }) => `${who}, from its memory`,
    pick: "Pick one to see what it adds or changes.",
    failed: "To review could not be read.",
    retry: "Try again",
    openChat: "Open the chat",
  },
  updates: {
    title: "Updates",
    check: "Check for updates",
    checking: "Checking…",
    checked: ({ count, waiting, updated }: { count: number; waiting: number; updated: number }) =>
      [
        `Checked ${skills(count)} from Git.`,
        waiting === 0
          ? "Nothing waits for you."
          : `${formatCount(waiting)} ${plural(waiting, { one: "update waits", other: "updates wait" })} for you.`,
        updated === 0 ? "" : `${skills(updated)} updated automatically.`,
      ]
        .filter((part) => part !== "")
        .join(" "),
    checkFailed: "The check could not run. Try again in a moment.",
    listLabel: "Updates that wait for you",
    revs: ({ from, to, scope }: { from: string; to: string; scope: string }) => `${from} → ${to} · ${scope}`,
    clean: "Clean",
    addsScript: "Adds a script",
    addsLink: "Adds a link",
    hiddenText: "Hidden text",
    notGiven: "Not given to anyone",
    lastChecked: ({ when }: { when: string }) =>
      `Checked ${when}. Hobbots looks once a day, and never changes a skill until you update it or turn on Update automatically.`,
    neverChecked:
      "Not checked yet. Hobbots looks once a day, and never changes a skill until you update it or turn on Update automatically.",
    problem: ({ where, message }: { where: string; message: string }) => `${where} could not be checked: ${message}`,
    emptyTitle: "Every skill is up to date",
    emptyBody:
      "Hobbots checks skills from Git once a day. When a repository has a new revision, it shows here with what changed.",
    back: "Back to the overview",
    found: ({ when }: { when: string }) => `found ${when}`,
    waitsBody: "It waits for you even with Update automatically on.",
    otherFiles: "Other files",
    noOtherFiles: "No other files changed",
    fileNote: { added: "New", removed: "Removed", changed: "Changed" },
    scriptNote: { added: "New script", removed: "Removed script", changed: "Changed script" },
    accept: ({ count }: { count: number }) =>
      count === 0
        ? "Update"
        : `Update and roll out to ${formatCount(count)} ${plural(count, { one: "hob", other: "hobs" })}`,
    notNow: "Not now",
    cut: ({ where }: { where: string }) =>
      `This SKILL.md is too long to show whole: only its first 200,000 characters are here, so a change after them does not show. Read the whole file in ${where} before you update.`,
    readWhole: "I read the whole SKILL.md in the repository, and want this update",
    accepted: ({ title, to, from }: { title: string; to: string; from: string }) =>
      `${title} ${to} is in your library and rolls out from each hob's next chat. ${from} stays in the history.`,
    dismissed: ({ title, rev }: { title: string; rev: string }) =>
      `Not now. ${title} stays on ${rev}. Hobbots shows the next upstream change.`,
    moved: "The repository changed since this check. Check for updates again to see what it holds now.",
    stale: "This skill changed in Hobbots since this check. Check for updates again.",
    failed: "The update could not be added. Try again in a moment.",
    readFailed: "Updates could not be read.",
    retry: "Try again",
    auto: "Update automatically",
    autoOn:
      "On. New revisions from this repository roll out to every hob as they arrive, and show in What changed with Roll back.",
    autoOff:
      "Off. Turn it on to take clean updates from this repository as they arrive. Updates that add a script or a link still wait for you.",
    autoFrom: ({ where }: { where: string }) => `Updates automatically from ${where}`,
    autoFailed: "Update automatically could not be changed. Try again in a moment.",
    available: ({ to }: { to: string }) => `Update available: ${to}`,
    facts: { who: "Who gets it", upstream: "Upstream" },
    nobody: "Nobody yet",
  },
  changes: {
    title: "What changed",
    intro: "Every new revision, rollout and skill given or taken away, newest first, with a way back.",
    empty: "Nothing changed yet. Saving a revision, giving a skill or rolling one out shows here.",
    today: "Today",
    yesterday: "Yesterday",
    aRevision: "a revision",
    byYou: "You",
    bySource: "Its source",
    byHob: ({ name }: { name: string }) => name,
    saved: ({ by }: { by: string }) => `${by} saved`,
    updatedAutomatically: "Updated automatically",
    updatedFrom: ({ where }: { where: string }) => `From ${where} · clean: no new script, link or hidden text`,
    savedLine: ({ name, rev, count }: { name: string; rev: string; count: number }) =>
      count === 0
        ? `${name} ${rev}, rolled out to nobody yet`
        : `${name} ${rev}, rolled out to ${formatCount(count)} ${plural(count, { one: "place", other: "places" })}`,
    heldNote: ({ who }: { who: string }) => `Kept ${who} on its revision`,
    rolledOut: "Rolled out",
    rolledBack: "Rolled back",
    movedLine: ({ name, from, to, who }: { name: string; from: string; to: string; who: string }) =>
      `${name} moved from ${from} to ${to} for ${who}`,
    assigned: "Given",
    assignedLine: ({ name, rev, who }: { name: string; rev: string; who: string }) => `${who} got ${name} ${rev}`,
    unassigned: "Taken away",
    unassignedLine: ({ name, who }: { name: string; who: string }) => `${name} was taken from ${who}`,
    held: "Kept back",
    heldLine: ({ name, rev, who }: { name: string; rev: string; who: string }) => `${who} stays on ${name} ${rev}`,
    followed: "Follows edits again",
    followedLine: ({ name, who }: { name: string; who: string }) => `${who} moves with each new ${name} revision again`,
    optedOut: "Turned off",
    optedOutLine: ({ name, hob }: { name: string; hob: string }) => `${name} is off for ${hob}`,
    optedIn: "Turned on",
    optedInLine: ({ name, hob }: { name: string; hob: string }) => `${name} is on for ${hob} again`,
    /** One skill of a set, named with the set it comes from. */
    memberOf: ({ member, set }: { member: string; set: string }) => `${member} from ${set}`,
    removed: "Removed",
    removedLine: ({ name }: { name: string }) => `${name} left the library`,
    rollBack: ({ rev }: { rev: string }) => `Roll back to ${rev}`,
    rolledBackDone: ({ name, rev }: { name: string; rev: string }) => `${name} is back on ${rev} where it moved.`,
    rollBackEach: "Roll back",
    rolledBackEach: ({ name }: { name: string }) => `${name} is back on the revision each place was on.`,
    rollBackFailed: "It did not roll back. A place may have moved since; open the skill to see where it is.",
    failed: "What changed could not be read.",
    retry: "Try again",
  },
  activity: {
    shows: "In the chat, it shows as",
    line: ({ name, rev }: { name: string; rev: string }) =>
      `Used ${name} (${rev}) under a reply that used it, with Open beside it.`,
    never: "No hob has used it yet. A line under a reply says each time one does.",
    summary: ({ total, week, hobs }: { total: number; week: number; hobs: number }) =>
      `Used ${formatCount(total)} ${plural(total, { one: "time", other: "times" })}, ${formatCount(week)} this week, by ${formatCount(hobs)} ${plural(hobs, { one: "hob", other: "hobs" })}.`,
    byHob: "By hob",
    notes: "Notes from hobs",
    notesFailed: "The notes hobs left on this skill could not be read.",
    note: ({ note }: { note: string }) => `“${note}”`,
    noteKind: { wrong: "wrong", outdated: "outdated", unclear: "unclear" },
    noteBy: ({ hob, kind, when, more }: { hob: string; kind: string; when: string; more: number }) =>
      more > 0
        ? `${hob}, ${kind} · ${when} · ${formatCount(more)} more ${plural(more, { one: "note suggests", other: "notes suggest" })} a revision`
        : `${hob}, ${kind} · ${when} · enough notes to suggest a revision`,
    chats: "In chats",
    chat: "A chat",
    chatLine: ({ hob, chat }: { hob: string; chat: string }) => `${hob}: ${chat}`,
    times: ({ count, when }: { count: number; when: string }) =>
      `${formatCount(count)} ${plural(count, { one: "time", other: "times" })} · last ${when}`,
    failed: "Its uses could not be read.",
    retry: "Try again",
  },
  scope: {
    title: ({ name }: { name: string }) => `${name}'s skills`,
    everyoneTitle: "Everyone's skills",
    projectTitle: ({ name }: { name: string }) => `The ${name} project's skills`,
    everyoneLine: "Every hob has them, and every hob you summon later.",
    projectLine: ({ identity }: { identity: string }) => `Any hob while it works in a clone of ${identity}.`,
    hobLine: "Only this hob has them. A hob's own skill replaces Everyone's or a project's of the same name.",
    empty: "No skill is given here yet. Open a skill and use Also give it to.",
    foot: "Open a hob in the list to turn an Everyone or project skill off for that hob alone.",
    openPage: ({ name }: { name: string }) => `Open ${name}'s page`,
  },
  loading: "Opening your skills…",
  failed: {
    title: "Skills did not open",
    body: "The hub did not answer. Your skills are safe; try again in a moment.",
    retry: "Try again",
    skill: "This skill did not open.",
    gone: "This skill is not in your library any more.",
    back: "Back to your skills",
  },
  empty: {
    title: "No skills yet",
    body: "A skill teaches hobs how you do something: your release steps, a review checklist, how you write a pull request. Every hob on Claude Code or Codex uses the same skill.",
    steps: [
      {
        title: "Add or write one",
        body: "From a Git repository, a folder or a .zip, or written here. Nothing in it ever runs while it is checked.",
      },
      {
        title: "Choose who gets it",
        body: "Everyone, the hobs working in a project, or one hob. Claude Code and Codex hobs use the same skill.",
      },
      {
        title: "Hobs suggest more",
        body: "When a hob repeats the same steps, it drafts a skill. You review it before anyone uses it.",
      },
    ],
    write: "Write one",
  },
  skill: {
    breadcrumb: "Breadcrumb",
    tabs: "Skill",
    instructions: "Instructions",
    who: "Who uses it",
    history: "History",
    activity: "Activity",
    byline: ({ who, when }: { who: string; when: string }) => `${who} on ${when}`,
    addedByYou: "added by you",
    addedByHob: "proposed by a hob",
    addedBySource: "added from its source",
    files: ({ rev }: { rev: string }) => `Files in ${rev}`,
    filesSize: ({ count, bytes }: { count: number; bytes: number }) => `${files(count)} · ${formatBytes(bytes)}`,
    // Read before the path, so a file link is named "Open SKILL.md" and its visible text is in its name.
    fileOpen: "Open ",
    script: "Runs as the hob's own command",
    aside: "About this skill",
    actions: "Actions",
    edit: "Edit",
    origin: "Where it came from",
    sourceLabel: "Source",
    folder: "Folder",
    commit: "Commit",
    version: "Version",
    first: "First",
    firstAdded: ({ when }: { when: string }) => `Added ${when}`,
    needs: "Needs",
    noCharm: "No Charm",
    charms: ({ charms }: { charms: ReadonlyArray<string> }) => formatList(charms),
    grants: "Grants",
    grantsNothing: "Nothing. Its scripts run as the hob's own commands, under its permissions.",
    leftOut: "Left out",
  },
  agents: {
    byline: ({ when }: { when: string }) => `from ~/.agents/skills on this computer · picked up ${when}`,
    note: ({ folder }: { folder: string }) =>
      `This skill lives in ${folder}, which other tools on this computer use too, so Hobbots only reads it. Change it in that folder: each change becomes a new revision here and rolls out to every hob. To change it just for your hobs, make a copy.`,
    readOnly: "read-only",
    fileReadOnly: "Read-only. Change it in its folder in ~/.agents/skills.",
    noEdit:
      "No Edit or Remove here: delete its folder in ~/.agents/skills to remove it, or turn it off for one hob on that hob's skills list.",
    source: ({ folder }: { folder: string }) => `${folder} on this computer`,
    revisions: "Revisions",
    revisionsText: "Made when the folder changes. Roll back and holding a hob back still work.",
    backups: "Backups",
    backupsText: "Not in backups or exports. Another computer reads its own folder.",
  },
  set: {
    tab: "Skills",
    uses: ({ count }: { count: number }) =>
      count === 0
        ? "Not used this week"
        : `Used ${formatCount(count)} ${plural(count, { one: "time", other: "times" })} this week`,
    byline: ({ who, when }: { who: string; when: string }) => `${who} on ${when}`,
    sharesIn: ({ folders }: { folders: ReadonlyArray<string> }) =>
      `its skills share the files in ${formatList(folders)}`,
    note: ({ folders }: { folders: ReadonlyArray<string> }) =>
      folders.length === 0
        ? "These skills come and update together, so their links to each other keep working. A hob can still turn one off on its skills list. To change one just for your hobs, open it and make a copy."
        : `These skills come and update together, so their links to each other and to ${formatList(folders)} keep working. A hob can still turn one off on its skills list. To change one just for your hobs, open it and make a copy.`,
    skills: "Skills",
    skillsLabel: "Skills in this set",
    typeHint: ({ name, set }: { name: string; set: string }) => `Type /${name}, or /${set}:${name}`,
    used: ({ count }: { count: number }) => (count === 0 ? "Never used" : `Used ${formatCount(count)}×`),
    shared: "Shared files",
    sharedHint: "Every hob that has the set gets them",
    linkedBy: ({ count, all }: { count: number; all: boolean }) =>
      count === 0
        ? "linked by another file"
        : all
          ? `linked by all ${formatCount(count)}`
          : `linked by ${formatCount(count)}`,
    aside: "About this set",
    whoUses: "Who uses it, holding a hob back",
    remove: "Remove the set…",
    version: ({ label, commit }: { label: string | null; commit: string | null }) =>
      [label, commit === null ? null : `commit ${commit.slice(0, 7)}`].filter((part) => part !== null).join(", "),
    leftOutNothing: "Nothing. It has no hooks, commands, agents or MCP servers.",
    needsSome: ({ charms }: { charms: ReadonlyArray<string> }) => `Its skills name ${formatList(charms)}.`,
    grantsNothing: "Nothing. Hobs follow it under their own permissions.",
  },
  member: {
    inSet: ({ set }: { set: string }) => `In ${set}`,
    byline: ({ set, name }: { set: string; name: string }) => `/${name} or /${set}:${name} · from the set ${set}`,
    note: ({ set }: { set: string }) =>
      `This skill comes with the set ${set}, so it changes only with a new version of the set. A hob can still turn it off on its skills list. To change it just for your hobs, make a copy.`,
    fileReadOnly: ({ set }: { set: string }) => `Read-only. It changes with a new version of ${set}.`,
    noEdit: ({ set }: { set: string }) =>
      `No Edit or Remove here: it comes and goes with ${set}. Open the set to give it out, hold it back or remove it.`,
    openSet: ({ set }: { set: string }) => `Open ${set}`,
  },
  copySkill: {
    open: "Make a copy…",
    label: ({ name }: { name: string }) => `Make a copy of ${name}`,
    name: "Typed as",
    nameHint: "Lowercase letters, digits and hyphens, as you type it after /",
    who: "Who gets it",
    nobody: "Nobody yet",
    nobodyNote: "Nobody gets the copy until you give it to someone. The original keeps following the folder.",
    nobodyNoteSet: "Nobody gets the copy until you give it to someone. The original keeps updating with its set.",
    everyoneNote: "Every hob gets both. Turn the original off on a hob's skills list if the copy should replace it.",
    projectNote: "Hobs in its folders get both. Turn the original off for them if the copy should replace it.",
    hobNote: ({ name }: { name: string }) =>
      `${name} gets both. Turn the original off for ${name} if the copy should replace it.`,
    starts: ({ count }: { count: number }) =>
      `The copy starts at r1 with the same ${files(count)}, and you can edit it.`,
    startsSet:
      "The copy starts at r1 with this skill's files and the files of the set it links to, and you can edit it.",
    confirm: "Make the copy",
    copying: "Copying…",
    cancel: "Cancel",
    done: ({ name }: { name: string }) =>
      `${name} is in your library at r1, and you can edit it. The original in ~/.agents/skills is unchanged.`,
    doneSet: ({ name, set }: { name: string; set: string }) =>
      `${name} is in your library at r1, and you can edit it. ${set} is unchanged.`,
    taken: "Your library has a skill of that name. Pick another name.",
    invalid: "Use lowercase letters, digits and hyphens, up to 64.",
    failed: "The copy was not made. Try again.",
  },
  file: {
    label: ({ path }: { path: string }) => `The file ${path}`,
    close: "Close the file",
    readOnly: "Read-only. Edit makes a new revision.",
    notText: ({ size }: { size: number }) => `This file is not text, so it is not shown here (${formatBytes(size)}).`,
    tooLong: ({ size }: { size: number }) => `This file is too long to show here (${formatBytes(size)}).`,
    loading: "Opening the file…",
    failed: "This file did not open.",
  },
  who: {
    intro:
      "Each place below gets this skill, pinned to a revision. Your edits roll out to every one of them unless you keep it on its revision.",
    none: "No hob has it yet. Use Also give it to, beside this, to give it to Everyone, a project or a hob.",
    everyoneSub: "Every hob, and every hob you summon later",
    projectSub: "Any hob while it works in its folders",
    hobSub: "Only this hob",
    heldSub: ({ rev }: { rev: string }) => `Kept on ${rev} · edits do not move it`,
    keep: ({ rev }: { rev: string }) => `Keep on ${rev}`,
    follow: "Follow edits again",
    move: ({ rev }: { rev: string }) => `Move to ${rev}`,
    takeAway: "Take it away",
    onlyWhenAsked: "Only when asked",
    onlyWhenAskedFor: ({ name }: { name: string }) => `Only when asked, for ${name}`,
    onlyWhenAskedHint: ({ name }: { name: string }) => `Used only when you type /${name}`,
    kept: ({ who, rev }: { who: string; rev: string }) => `${who} stays on ${rev} when you save a new revision.`,
    followed: ({ who }: { who: string }) => `${who} follows your edits again.`,
    moved: ({ who, rev }: { who: string; rev: string }) => `${who} moves to ${rev} from its next chat.`,
    takenAway: ({ who }: { who: string }) => `${who} no longer has this skill, from its next chat.`,
    askedOn: ({ who, name }: { who: string; name: string }) => `${who} uses it only when you type /${name}.`,
    askedOff: ({ who }: { who: string }) => `${who} can pick it on its own when a task matches.`,
    failed: "That did not change. Try again.",
  },
  give: {
    open: "Also give it to…",
    label: "Give it to",
    everyone: "Everyone",
    everyoneSub: "Every hob",
    hob: ({ name }: { name: string }) => name,
    hobSub: "This hob only",
    project: ({ name }: { name: string }) => `The ${name} project`,
    projectSub: "Hobs in its folders",
    done: ({ who, rev }: { who: string; rev: string }) => `${who} gets ${rev} from its next chat.`,
    failed: "It was not given. Try again.",
  },
  history: {
    label: "Revisions",
    latest: "Newest",
    byYou: "You added it",
    byHob: "A hob proposed it, and you added it",
    bySource: "Came from its source",
    meta: ({ when, extra }: { when: string; extra: ReadonlyArray<string> }) => [when, ...extra].join(" · "),
    commit: ({ commit }: { commit: string }) => `commit ${commit}`,
    flagged: "flagged",
    changes: "Changes",
    hideChanges: "Hide changes",
    changesOf: ({ from, to }: { from: string; to: string }) => `What ${to} changed against ${from}`,
    filesChanged: ({ added, removed, changed }: { added: number; removed: number; changed: number }) =>
      `Other files: ${formatCount(added)} added, ${formatCount(removed)} removed, ${formatCount(changed)} changed`,
    sameSkillFile: "SKILL.md did not change.",
    loading: "Reading both revisions…",
    failed: "The changes did not open.",
    added: "Added",
    removed: "Removed",
    first: "The first revision.",
    rollBack: ({ rev }: { rev: string }) => `Roll back to ${rev}`,
    rolledBack: ({ rev, count }: { rev: string; count: number }) =>
      count === 0
        ? `Every place is on ${rev} already, or kept on its own revision.`
        : `Rolled back to ${rev}: ${formatCount(count)} ${plural(count, { one: "place moves", other: "places move" })} to it from the next chat. The newer revisions stay in the history.`,
    rollFailed: "It was not rolled back. Try again.",
  },
  flags: {
    title: "Worth a careful look",
    script: ({ path }: { path: string }) => `${path} is a script. It runs only as the hob's own command.`,
    url: ({ path, url }: { path: string; url: string }) => `${path} links to ${url}.`,
    hidden: ({ path, codePoint }: { path: string; codePoint: string }) =>
      `${path} holds text hidden from view (${codePoint}).`,
  },
  dropped: {
    hooks: "hooks",
    commands: "commands",
    agents: "agents",
    "mcp-servers": "MCP servers",
    "allowed-tools": "allowed-tools",
    "tool-dependencies": "tool dependencies",
  } satisfies Record<SkillDroppedKind, string>,
  droppedLine: ({ kinds }: { kinds: ReadonlyArray<string> }) =>
    `Left out: ${formatList(kinds)}. Skills carry instructions only.`,
  remove: {
    open: "Remove from the library…",
    label: ({ name }: { name: string }) => `Remove ${name}`,
    title: "Remove it from the library?",
    body: "Its revisions go with it. No hob has it, so nothing changes for them.",
    confirm: "Remove",
    cancel: "Keep it",
    removing: "Removing…",
    inUse: ({ count }: { count: number }) =>
      `${formatCount(count)} ${plural(count, { one: "place still gives it", other: "places still give it" })}`,
    inUseBody: ({ who }: { who: string }) => `${who}. Take it from them first, then remove it.`,
    everyone: "Everyone",
    project: ({ name }: { name: string }) => `the ${name} project`,
    formerHob: "a retired hob",
    done: ({ name }: { name: string }) => `${name} is no longer in your library.`,
    failed: "It was not removed. Try again.",
  },
  editor: {
    newTitle: "Write a skill",
    editTitle: ({ name }: { name: string }) => `Edit ${name}`,
    editing: ({ name, rev }: { name: string; rev: string }) => `${name} · editing ${rev}`,
    name: "Name",
    typedAsName: ({ name }: { name: string }) => `Typed as ${name}`,
    typedAsBad: ({ name }: { name: string }) =>
      `Typed as ${name}. Use lower-case letters, digits and single hyphens, at most 64.`,
    nameHint: "Lower-case letters, digits and hyphens, such as release-steps.",
    description: "When to use it",
    descriptionShort: "Too short to pick well. Say when a hob should use it.",
    descriptionLong: "Too long: Claude Code and Codex cut it at 1,024 characters.",
    descriptionGood: "Good: it says when to use it.",
    descriptionCount: ({ count }: { count: number }) => `${formatCount(count)} / 1,024`,
    instructions: "Instructions",
    instructionsHint: "Markdown. A hob reads it when a task matches what the skill is for.",
    checked: "Checked when you save: front matter, links inside the skill, size",
    saveNew: "Add to the library",
    save: ({ rev }: { rev: string }) => `Save as ${rev}`,
    saving: "Saving…",
    cancel: "Cancel",
    unchanged:
      "Nothing to save yet: change the description or instructions to make a new revision. To keep a place on its revision now, use Who uses it.",
    sameAsBase: ({ rev }: { rev: string }) =>
      `That saves as ${rev} again, so nothing was saved and no place moved. Change the description or instructions to make a new revision, or use Who uses it to keep a place on its revision.`,
    older: ({ rev }: { rev: string }) =>
      `That is ${rev} again, so nothing was saved and no place moved. To go back to it, use Roll back to ${rev} in History.`,
    added: ({ name }: { name: string }) => `Added ${name} as r1. No hob has it yet.`,
    notGiven: ({ name, who }: { name: string; who: string }) =>
      `Added ${name} as r1, but it was not given to ${who} yet. Save again to give it: it is not added twice.`,
    addedGiven: ({ name, who }: { name: string; who: string }) =>
      `Added ${name} as r1. ${who} gets it from the next chat.`,
    saved: ({ rev }: { rev: string }) => `Saved ${rev}. No hob moved to it yet.`,
    same: ({ rev }: { rev: string }) => `That is ${rev} already, so nothing new was saved.`,
    taken: "Your library has a skill of that name. Pick another name, or edit that one.",
    failed: "It was not saved. Your text is still here; try again.",
    readOnly:
      "This skill comes from ~/.agents/skills, which Hobbots only reads, so it was not saved. Change it in that folder, or make a copy to edit it here.",
    newer: ({ rev, base }: { rev: string; base: string }) =>
      `${rev} was saved while you edited ${base}, so this edit cannot be saved over it. Your text is still here: copy it, then edit ${rev}.`,
    unfinished: ({ rev }: { rev: string }) =>
      `${rev} is now the newest: your save may have reached the hub before it failed. Finish saving sends it again as it was, which finishes it, or is refused if someone else saved ${rev}.`,
    finish: "Finish saving",
    stale:
      "A newer revision was saved while you edited, so this was not saved. Your text is still here: copy it, then edit the newest revision.",
  },
  giveChoice: {
    legend: "Give it to",
    legendMany: "Give them to",
    nobody: "Nobody yet",
    nobodySub: "Library only",
    everyone: "Everyone",
    everyoneSub: "Every hob",
    project: ({ name }: { name: string }) => `The ${name} project`,
    projectSub: "Hobs in its folders",
    hobSub: "This hob only",
  },
  rollout: {
    title: ({ count }: { count: number }) =>
      count === 0
        ? "Rolls out to nobody yet"
        : `Rolls out to ${formatCount(count)} ${plural(count, { one: "place", other: "places" })} when you save`,
    body: ({ next, now }: { next: string; now: string }) =>
      `Saving makes ${next}. Every place that has this skill moves to it from its next chat. A chat already running finishes on ${now}.`,
    moves: ({ who, rev }: { who: string; rev: string }) => `${who} moves to ${rev}`,
    keeps: ({ who }: { who: string }) => `Keep ${who} on its revision`,
    held: ({ rev }: { rev: string }) => `Stays on ${rev}`,
    follows: "Moves when you save",
    save: ({ count, rev }: { count: number; rev: string }) =>
      count === 0
        ? `Save ${rev} without rolling out`
        : `Save and roll out to ${formatCount(count)} ${plural(count, { one: "place", other: "places" })}`,
    saved: ({ rev, count }: { rev: string; count: number }) =>
      count === 0
        ? `Saved ${rev}. No place moved to it yet.`
        : `Saved ${rev} and rolled it out to ${formatCount(count)} ${plural(count, { one: "place", other: "places" })} from their next chat.`,
  },
  import: {
    title: "Add a skill",
    intro:
      "A skill is a folder with a SKILL.md. Hobbots copies it into your library, checks it and never runs anything from it.",
    from: "From",
    tabs: {
      git: { label: "From Git", sub: "A repository, pinned to a commit" },
      file: { label: "Folder or .zip", sub: "From this computer" },
      write: { label: "Write one", sub: "Here, or with a hob" },
    },
    repository: "Repository",
    ref: "Branch, tag or commit",
    refHint: "The default branch when empty",
    look: "Look",
    looking: "Looking…",
    folder: "Folder on the hub's computer",
    chooseFolder: "Choose a folder…",
    zip: "Choose a .zip…",
    zipLabel: "A .zip or .skill file",
    or: "or",
    drop: "A skill folder or a .zip",
    limits: "Up to 5 MB and 200 files a skill. Nothing in it runs while it is checked.",
    blank: "Start from a blank skill",
    blankHint: "Name, when to use it, and the steps. Hobbots checks it as you type.",
    draft: "Draft it with a hob",
    draftHint:
      "Opens a chat where a hob writes it from your words, a chat or its memory. You review it before it is added.",
    draftWho: "Which hob drafts it?",
    draftWhoHint: "It opens a new chat with that hob, with a message you can change before you send it.",
    draftLooking: "Looking for hobs that may suggest skills…",
    draftLookFailed: "Hobbots could not read your hobs, so it cannot tell which may suggest skills.",
    draftTryAgain: "Try again",
    draftNoneTitle: "No hob may suggest skills now",
    draftNone: "In a hob's Permissions, allow Suggest a new skill or a change, then come back.",
    /** The message a drafting chat starts from, ready to change before it is sent. */
    draftMessage: [
      "Please write a new skill for my library and propose it, so I can review it before it is added.",
      "",
      "What it is for: ",
      "",
      "Learn from (optional): a chat of ours, or pages in your memory",
    ].join("\n"),
    found: ({ count, commit }: { count: number; commit: string | null }) =>
      commit === null ? `Found ${skills(count)}.` : `This is commit ${commit.slice(0, 7)}. Found ${skills(count)}.`,
    pick: ({ name }: { name: string }) => `Import ${name}`,
    already: "Already in your library",
    alreadyLine: ({ rev }: { rev: string }) => `Same content as ${rev}, nothing new to add`,
    newRevision: "A new revision of a skill you have",
    newRevisionLine:
      "Hobbots cannot add a source's new content to a skill you have yet. Edit on that skill changes its description and instructions.",
    passed: ({ count, bytes }: { count: number; bytes: number }) =>
      `Checks passed · ${files(count)}, ${formatBytes(bytes)}`,
    passedNoSize: "Checks passed",
    setPassed: "Passed every check",
    setIntro: "This source is a plugin whose skills share files, so it comes in as one set, and it updates as one.",
    foundSet: ({ label, commit }: { label: string | null; commit: string | null }) =>
      `${commit === null ? "" : `${label ?? "This"} is commit ${commit.slice(0, 7)}. `}This source is a plugin whose skills share files, so it comes in as one set, and it updates as one.`,
    setLabel: ({ name }: { name: string }) => `The set ${name}`,
    setSkills: ({ name }: { name: string }) => `The skills in ${name}`,
    sharedBy: ({ folders, count }: { folders: ReadonlyArray<string>; count: number }) =>
      `Shared by them: ${formatList(folders)}, ${files(count)}. Links inside the set stay as written; a link outside it would have been refused.`,
    noShared: "Its skills share no files. Links inside the set stay as written.",
    setLegend: "Give the set to",
    setNote:
      "A set comes in whole and updates as one. A hob can still turn off any of its skills on its own skills list.",
    addSet: ({ name, count }: { name: string; count: number }) => `Add ${name}, ${skills(count)}`,
    addedSet: ({ name, count }: { name: string; count: number }) =>
      `Added ${name} with its ${skills(count)}. No hob has them yet.`,
    addedSetGiven: ({ name, count, who }: { name: string; count: number; who: string }) =>
      `Added ${name}. ${who} gets its ${skills(count)} from the next chat.`,
    flagged: "Worth a look",
    importN: ({ count }: { count: number }) => (count === 0 ? "Pick a skill to import" : `Import ${skills(count)}`),
    importing: "Importing…",
    nothing: "Nothing to import",
    cancel: "Cancel",
    refusedTitle: "Nothing can be imported from it",
    refusedBody: "Its skills failed the checks below, so Hobbots wrote nothing to your library.",
    refusedFix: "Fix it at the source, then Look again.",
    unreadable: "That source could not be read. Check the address or the path, then try again.",
    tooLarge: "That file is over 50 MB, so it was not read.",
    none: "There is no SKILL.md in it.",
    imported: ({ count }: { count: number }) => `Imported ${skills(count)} as r1. No hob has them yet.`,
    importedGiven: ({ count, who }: { count: number; who: string }) =>
      `Imported ${skills(count)} as r1. ${who} gets ${plural(count, { one: "it", other: "them" })} from the next chat.`,
    refusedRule: ({ path, rule }: { path: string; rule: string }) => `${path}: ${rule}`,
    failed: "Nothing was imported. Try again.",
    notGiven: ({ count, who }: { count: number; who: string }) =>
      `Imported ${skills(count)}, but ${plural(count, { one: "it was", other: "they were" })} not given to ${who} yet. Give ${plural(count, { one: "it", other: "them" })} again: nothing is imported twice.`,
    giveAgain: "Give again",
    moved: "The source changed since you looked, so nothing was imported. Look again to see what it holds now.",
    exportedNote: ({ when, count }: { when: string; count: number }) =>
      count === 0
        ? `A Hobbots export from ${when}. Each skill comes with the revisions it names.`
        : `A Hobbots export from ${when}. Each skill comes with the revisions it names, and ${formatCount(count)} ${plural(count, { one: "assignment", other: "assignments" })} of who gets it, for the hobs and projects this hub has.`,
    exportedLine: ({ count }: { count: number }) =>
      count === 0
        ? "Exactly the exported revision"
        : `Exactly the exported revision, with ${formatCount(count)} older ${plural(count, { one: "one", other: "ones" })} an assignment keeps`,
    exportedChanged: "Changed since it was exported, so it comes in as a new skill of its own",
    /** An older revision an export brings with a skill, and what import notes of it, as for the newest. */
    olderNotes: ({ rev, notes }: { rev: string; notes: ReadonlyArray<string> }) =>
      `${rev}, which an assignment keeps: ${notes.join(" ")}`,
    olderRefused: ({ rev, rule }: { rev: string; rule: string }) =>
      `${rev}, which an assignment keeps, cannot be imported: ${rule}`,
    olderChanged: ({ rev }: { rev: string }) =>
      `${rev}, which an assignment keeps, is no longer the exported revision, so this skill cannot be imported from here. Export it again.`,
    importedSet: ({ count, given, left }: { count: number; given: number; left: number }) => {
      const base = `Imported ${skills(count)} with the revisions the export names`;
      const assigned =
        given === 0
          ? ""
          : `, and gave out ${formatCount(given)} ${plural(given, { one: "assignment", other: "assignments" })}`;
      const kept =
        left === 0
          ? ""
          : ` ${formatCount(left)} ${plural(left, { one: "names a hob", other: "name hobs" })} this hub does not have, so ${plural(left, { one: "it stays", other: "they stay" })} out.`;
      return `${base}${assigned}.${kept}`;
    },
    taken: ({ name }: { name: string }) =>
      `Your library already has ${name}. Hobbots cannot add a source's new content to it yet; Edit on that skill changes its description and instructions.`,
  },
  checks: {
    "front-matter": "SKILL.md needs front matter with a name and a description between --- lines.",
    "outside-path": "A link or a path points outside the skill folder, or outside its set. Links must stay inside.",
    set: "A skill in a set changes only with a new version of the set. Make a copy to change it.",
    symlink: "It holds a symbolic link. A skill's files must be plain files.",
    "too-large": "It is over 5 MB.",
    "too-many-files": "It has more than 200 files.",
    unreadable: "A file could not be read.",
  } satisfies Record<SkillCheck, string>,
  wholeSkill: "The whole skill",
  revision: ({ number }: { number: number }) => `r${formatCount(number)}`,
  day: (iso: string) => formatDay(iso),
} as const;
