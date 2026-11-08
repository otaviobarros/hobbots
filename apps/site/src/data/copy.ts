/** The words, lists and links on the 0.0.3 launch page, from boards 4 and 5 of the design canvas. */

export const GITHUB = "https://github.com/otaviobarros/hobbots";
export const CONTACT = "aldric@hobbots.app";
export const RELEASES = `${GITHUB}/releases`;
export const REPORT = `${GITHUB}/issues/new/choose`;

/** The release this page announces. */
export const RELEASE = {
  version: "0.0.3",
  date: "November 8, 2026",
  notes: `${RELEASES}/tag/v0.0.3`,
} as const;

/** One installer of this release, named by `ARTIFACT_NAME` in apps/desktop/electron-builder.config.mjs. */
const installer = (arch: string, ext: string) =>
  `${RELEASES}/download/v${RELEASE.version}/Hobbots-${RELEASE.version}-${arch}.${ext}`;

export const DOWNLOADS = {
  macArm: installer("arm64", "dmg"),
  macIntel: installer("x64", "dmg"),
  debX64: installer("amd64", "deb"),
  debArm: installer("arm64", "deb"),
  rpmX64: installer("x86_64", "rpm"),
  rpmArm: installer("aarch64", "rpm"),
} as const;

export const NAV = [
  { href: "#tour", label: "Tour", long: "Inside the workshop" },
  { href: "#memory", label: "Memory", long: "Memory" },
  { href: "#skills", label: "Skills", long: "Skills" },
  { href: "#safety", label: "Safety", long: "Safety" },
  { href: "#faq", label: "Questions", long: "Questions" },
] as const;

/**
 * The presentation video lives in the public R2 bucket behind media.hobbots.app, not in this repository.
 * Upload a new cut with `wrangler r2 object put hobbots-media/video/hobbots-at-work.mp4 --file … --remote`.
 */
export const VIDEO = {
  url: "https://media.hobbots.app/video/hobbots-at-work.mp4",
  poster: "/video/poster.webp",
  length: "2:14",
} as const;

export const HERO = {
  title: "Not a new AI. A home for the ones you already use.",
  lede: "Hobbots turns the Claude or ChatGPT you already pay for into a little team on your computer. Each hob has its own name, folders, skills and memory. Hand one a goal, and it plans the work, brings in the others and asks you only when it matters.",
} as const;

export interface Shot {
  /** The file in public/screens, without its extension. Each has a 2560 and a 1280 pixel wide copy. */
  readonly file: string;
  readonly alt: string;
}

interface Slide extends Shot {
  readonly name: string;
  readonly title: string;
  readonly body: string;
}

export const SLIDES: ReadonlyArray<Slide> = [
  {
    name: "Home",
    file: "home",
    title: "Know where everything stands",
    body: "Who is working, who is resting, and the one decision that needs you first.",
    alt: "Home: six hobs in the night scene, and a question from Ada at the top.",
  },
  {
    name: "Quest room",
    file: "room",
    title: "Coordination you can watch",
    body: "The lead splits the goal, hands out the tasks and answers what it can. Every hob works in its own lane.",
    alt: "The Quest room: lanes for Aldric, Quill and Ada beside the lead’s chat.",
  },
  {
    name: "Needs you",
    file: "chat",
    title: "Checkpoints, not surprises",
    body: "Real decisions and risky steps stop and wait for you, with a recommended answer and the reason why.",
    alt: "A chat where Ada asks you to choose a shipping cutoff from two options.",
  },
  {
    name: "Memory",
    file: "memory",
    title: "Better with every job",
    body: "Hobs keep what they learned as pages you can read and correct, so the next job starts smarter.",
    alt: "The Memory page: recently learned pages and About you.",
  },
  {
    name: "Skills",
    file: "skills",
    title: "Your standards, every time",
    body: "Skills carry your checklists and your voice to every hob, versioned and rolled out when you say so.",
    alt: "The Skills page: four skills and who has each one.",
  },
  {
    name: "A hob’s page",
    file: "hob-page",
    title: "Accountable by name",
    body: "Each hob has a page with its chats, Quests, open work and history, so you always know who did what.",
    alt: "Aldric’s page: his portrait, his chat, the Quest he leads and his backpack.",
  },
];

export const STEPS = [
  {
    title: "Summon a hob",
    body: "Give it a name, a look, the folders it may work in, its skills, and whether it thinks with Claude or ChatGPT.",
  },
  {
    title: "Hand it a goal",
    body: "It splits the goal into tasks and leads a Quest, bringing in the other hobs it needs. Each one works in its own lane.",
  },
  {
    title: "Answer what needs you",
    body: "Questions and approvals wait in one place. Pick the recommended option, another one, or say it in your own words.",
  },
] as const;

export interface Feature {
  readonly id: string;
  readonly label: string;
  readonly title: string;
  readonly lede: string;
  readonly back: Shot;
  readonly front: Shot;
  /** What it does, why it is different, how it works. */
  readonly points: ReadonlyArray<{ readonly title: string; readonly body: string }>;
}

export const MEMORY: Feature = {
  id: "memory",
  label: "New · Memory",
  title: "Hobs that remember, and show you what",
  lede: "Most AI forgets you the moment a chat ends, or remembers things you can’t see. Each hob keeps its own memory of what it learned doing your work, and every bit of it is a page you can read.",
  back: {
    file: "memory",
    alt: "The Memory page: what Aldric and Pip learned recently, and About you, which every hob reads.",
  },
  front: {
    file: "memory-page",
    alt: "A memory page, Publishing a preview link, learned by Aldric, with Edit, Pin and Delete.",
  },
  points: [
    {
      title: "What it does",
      body: "A hob saves decisions, gotchas and how-tos as it works, and reads them before its next chat. Every hob also reads About you, which you write once.",
    },
    {
      title: "Why it is different",
      body: "Nothing is hidden. Edit, pin or delete any page, with Undo. When a hob wants to share a lesson with other hobs, it waits for your OK first.",
    },
    {
      title: "How it works",
      body: "Memory lives on your computer, beside Hobbots. It uses your own Claude or ChatGPT sign-in, with no extra key, and it is in every backup.",
    },
  ],
};

export const SKILLS: Feature = {
  id: "skills",
  label: "New · Skills",
  title: "Teach it once. Every hob gets better.",
  lede: "A skill is your way of doing something, written down: a review checklist, how to write a launch email, your brand voice. Give it to one hob or to all of them.",
  back: {
    file: "skills",
    alt: "The Skills page: a library of four skills, given to everyone, to Pip only, or not given yet.",
  },
  front: { file: "hob-skills", alt: "Pip’s Skills tab: the skills Pip carries and where each one comes from." },
  points: [
    {
      title: "What it does",
      body: "A hob loads a skill only when the task matches it, and every reply says which skills it used.",
    },
    {
      title: "Why it is different",
      body: "Every change is a new version. Roll it out when you are ready, keep one hob on the old one, or roll back. Hobs can suggest a new skill from their work, and it waits for your review.",
    },
    {
      title: "How it works",
      body: "Write one with a hob, or import a folder, a .zip or a whole plugin. Your skills go with every backup and export.",
    },
  ],
};

export const SAFETY: { shot: Shot; ticks: ReadonlyArray<string> } = {
  shot: { file: "inbox", alt: "The Inbox: Ada’s question about the shipping cutoff, waiting for your answer." },
  ticks: [
    "Hobs work only inside the folders you give them",
    "Pushing to GitHub waits for your approval",
    "History keeps every decision you made",
  ],
};

export const THEMES: ReadonlyArray<Shot & { name: string; kind: string; chip: string }> = [
  { name: "Workshop Night", kind: "Pixel · dark", chip: "#141228", file: "home", alt: "Home in Workshop Night." },
  {
    name: "Workshop Daylight",
    kind: "Pixel · light",
    chip: "#f4efe4",
    file: "theme-workshop-daylight",
    alt: "Home in Workshop Daylight.",
  },
  {
    name: "Lamplight Dusk",
    kind: "Smooth · dark",
    chip: "#17161f",
    file: "theme-lamplight-dusk",
    alt: "Home in Lamplight Dusk.",
  },
  {
    name: "Lamplight Paper",
    kind: "Smooth · light",
    chip: "#f7f4ef",
    file: "theme-lamplight-paper",
    alt: "Home in Lamplight Paper.",
  },
];

export const TRUST = [
  {
    title: "Your data stays with you",
    body: "Every thread, memory and skill lives on your computer. There is no Hobbots account and no Hobbots server in between.",
  },
  {
    title: "Brings the AI you already use",
    body: "Hobs run on your Claude or ChatGPT plan, so there is nothing new to pay for and no API key to manage.",
  },
  {
    title: "Open source, Apache 2.0",
    body: "Read every line on GitHub, run it from source and send fixes. Free forever.",
  },
] as const;

export const FAQ = [
  {
    q: "Is it really free?",
    a: "Yes. Hobbots is open source under Apache 2.0 and free forever. You only pay for your own Claude or ChatGPT plan.",
  },
  {
    q: "Do I need to be technical?",
    a: "No. If you can use Claude or ChatGPT, you can use Hobbots. The first run checks your sign-in and walks you through each step.",
  },
  {
    q: "Does my work leave my computer?",
    a: "Hobbots keeps every thread, memory, skill and backup on your computer. Your hobs talk to Claude or ChatGPT the same way their own apps do.",
  },
  {
    q: "Is Linux supported?",
    a: "There is an experimental build for Ubuntu 24.04, Debian and Fedora. It is not fully tested yet, so expect rough edges and please report what breaks.",
  },
  {
    q: "Why does macOS block the first launch?",
    a: "The beta is not signed by an Apple developer yet. Choose Open Anyway once in Privacy & Security and later launches open normally.",
  },
  {
    q: "How do I update?",
    a: "There are no automatic updates yet. Install the new version over the old one. Your hobs, memory and skills stay where they are.",
  },
  {
    q: "What does not work yet?",
    a: "Browser use and hobs that manage other hobs are not built yet. The release notes list every known limit.",
  },
] as const;

/** The page's title and description, and the card that X, Slack and others show for a shared link. */
export const SHARE = {
  title: "Hobbots: a home for the AI you already use",
  description:
    "Hobbots turns the Claude or ChatGPT you already pay for into a little team on your computer. Free and open source, for Mac, with an experimental Linux build.",
  /** 1200 × 630, cropped from the video's poster. */
  image: "/og.png",
  imageAlt:
    "Aldric, the chief of the hobs, with his lantern staff above the words: You already have powerful AI agents.",
} as const;
