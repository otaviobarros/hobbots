import type { OsIcon } from "./scene.ts";

/** The words and lists on the coming soon page, from board 1 of the design canvas. */

export const GITHUB = "https://github.com/otaviobarros/hobbots";
export const CONTACT = "aldric@hobbots.app";

export const NAV = [
  { href: "#teaser", label: "Teaser" },
  { href: "#coming", label: "What's coming" },
  { href: "#everywhere", label: "Platforms" },
  { href: "#roll", label: "Roll a hob" },
  { href: GITHUB, label: "GitHub" },
] as const;

export const REPORT = [
  { text: "Sorted 14 support emails", done: true, delay: 0.4 },
  { text: "Drafted 9 replies", done: true, delay: 0.9 },
  { text: "5 refunds need you", done: false, delay: 1.4 },
] as const;

export const QUEST = [
  { state: "Asked", fg: "var(--color-moonlight)", motion: "" },
  { state: "Working", fg: "var(--color-mint)", motion: "hb-bob" },
  { state: "Waiting", fg: "var(--color-lantern)", motion: "pulse" },
] as const;

export const DREAMS = [
  { title: "Rooms", body: "Group chats where several hobs and you work in one place.", color: "var(--color-rose)" },
  {
    title: "Charms",
    body: "Connect Slack, Google Drive and any MCP server, granted per hob.",
    color: "var(--color-lilac)",
  },
  { title: "Routines", body: "Hobs that do recurring chores on a schedule.", color: "var(--color-lantern)" },
  { title: "Memory", body: "Hobs that remember what matters to you between threads.", color: "var(--color-mint)" },
  {
    title: "Approvals on your phone",
    body: "Answer an Ask from bed, the first thing after launch.",
    color: "var(--color-sky)",
  },
] as const;

const AT_LAUNCH = { state: "At launch", fg: "var(--color-mint)" };
const AFTER_LAUNCH = { state: "After launch", fg: "var(--color-lantern)" };

export const PLATFORMS: ReadonlyArray<{ name: string; icon: OsIcon; state: string; fg: string; body: string }> = [
  {
    name: "macOS",
    icon: "mac",
    ...AT_LAUNCH,
    body: "A signed app for macOS 13 Ventura or later, on Apple silicon and Intel.",
  },
  {
    name: "Linux",
    icon: "linux",
    ...AT_LAUNCH,
    body: "AppImage and .deb for x64 and arm64. Or run it from source in your browser.",
  },
  { name: "Windows", icon: "windows", ...AFTER_LAUNCH, body: "The same app for Windows 10 and 11, on x64 and arm64." },
  {
    name: "iPhone and Android",
    icon: "mobile",
    ...AFTER_LAUNCH,
    body: "Check on your hobs and answer approvals from your phone.",
  },
];

const NEXT = { state: "Next", fg: "var(--color-secondary-text)" };

export const PROVIDERS = [
  { name: "Claude", letter: "C", color: "#e39a74", state: "First", fg: "var(--color-mint)" },
  { name: "ChatGPT", letter: "G", color: "#8fd3a8", ...NEXT },
  { name: "Gemini", letter: "G", color: "var(--color-sky)", ...NEXT },
  { name: "Grok", letter: "X", color: "var(--color-secondary-text)", ...NEXT },
  { name: "Local models", letter: "L", color: "var(--color-moonlight)", ...NEXT },
  { name: "Any OpenAI-compatible key", letter: "+", color: "var(--color-lilac)", ...NEXT },
] as const;

export const TRUST = [
  {
    title: "Open source, free forever",
    body: "Apache 2.0 and free forever. Read the code, file an issue or send a pull request.",
    color: "var(--color-mint)",
  },
  {
    title: "Your work stays on your computer",
    body: "Threads and hobs live in a local folder on your machine. No Hobbots cloud account.",
    color: "var(--color-moonlight)",
  },
  {
    title: "Bring the AI you already use",
    body: "Hobs start on Claude, with your own plan. More providers follow, so you are never locked to one.",
    color: "var(--color-lantern)",
  },
] as const;

/**
 * The teaser lives in the public R2 bucket behind media.hobbots.app, not in this repository.
 * Upload a new cut with `wrangler r2 object put hobbots-media/teaser/night-shift-60s.mp4 --file … --remote`.
 */
export const TEASER_URL = "https://media.hobbots.app/teaser/night-shift-60s.mp4";

/** The page's title and description, and the card that X, Slack and others show for a shared link. */
export const SHARE = {
  title: "Hobbots: little helpers that do your chores while you sleep",
  description:
    "Stop being the messenger between your AIs. Summon hobs, give them a job, and they split the work, talk to each other and ask you before anything risky. Coming soon to macOS and Linux.",
  /** The teaser's own words, also shown above the video. */
  teaser:
    "Hand one job to Aldric before bed. While you sleep, the hobs split it up, pass notes and ask before anything risky. In the morning it is done, tested and verified.",
  /** 1200 × 630, cropped from the teaser poster. */
  image: "/og.png",
  imageAlt:
    "Hobbots, coming soon at hobbots.app: the chief of the hobs with a lantern staff and five hobs under a starry sky.",
} as const;
