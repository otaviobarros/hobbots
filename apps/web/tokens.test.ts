import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * The token guard (docs/design/themes.md, STD-UI-001, STD-UI-004): components read colors, type,
 * corners, edges and motion from the theme tokens and the skin, never as fixed values. Each test
 * lists every break as `path: class`, so a failure names the file and what to change.
 */

interface ThemeFile {
  readonly type: Readonly<Record<string, { readonly size: string }>>;
  readonly duration: Readonly<Record<string, string>>;
  readonly font: Readonly<Record<string, string>>;
  readonly size: Readonly<Record<string, string>>;
}

const themes: ThemeFile = JSON.parse(readFileSync(new URL("../../docs/design/themes.json", import.meta.url), "utf8"));

const ROOTS = [
  ["apps/web/src", new URL("./src/", import.meta.url)],
  ["packages/ui/src", new URL("../../packages/ui/src/", import.meta.url)],
] as const;

/** Pixel art palettes keep their own inks in every theme (docs/design/themes.md). */
const ART = /^apps\/web\/src\/art\//;

/** Top-level CSS rules that hold tokens: `@theme`, `@theme inline`, `@theme static`, `:root` and each theme's or look's rule. */
const TOKEN_BLOCK = /^(@theme(\s+(inline|static))?|:root(\[data-theme\^?="[\w-]+"\])?)\s*\{\n[\s\S]*?^\}/gm;

/** Comments name issues such as (#386), which read like short hex colors, and quote old values. */
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

interface Source {
  readonly path: string;
  /** The code without comments, and for a stylesheet without its token blocks. */
  readonly code: string;
}

const sources: readonly Source[] = ROOTS.flatMap(([root, folder]) =>
  readdirSync(folder, { recursive: true, encoding: "utf8" })
    .filter((path) => /\.(tsx?|css)$/.test(path) && !/\.test\.tsx?$/.test(path) && !/(^|\/)test\//.test(path))
    .map((path) => {
      const text = withoutComments(readFileSync(new URL(path, folder), "utf8"));
      return { path: `${root}/${path}`, code: path.endsWith(".css") ? text.replace(TOKEN_BLOCK, "") : text };
    }),
);

/** Classes a file may keep, by path. A variant such as `hover:` does not change what is allowed. */
type Allowed = Readonly<Record<string, readonly string[]>>;

/** Every match of `pattern` in every source that `include` keeps, as `path: match`, minus the allowed ones. */
const breaks = (
  pattern: RegExp,
  { include = () => true, allowed = {} }: { include?: (path: string) => boolean; allowed?: Allowed } = {},
): string[] =>
  sources
    .filter(({ path }) => include(path))
    .flatMap(({ path, code }) =>
      [...code.matchAll(pattern)]
        .map(([match]) => match)
        .filter((match) => !allowed[path]?.includes(match.replace(/^(?:[\w-]+:)+/, "")))
        .map((match) => `${path}: ${match}`),
    );

/** A class name in markup: not part of a longer name, so `max-w-xs` is not `text-xs`. */
const cls = (body: string) => new RegExp(`(?<![\\w-])${body}(?![\\w-])`, "g");

describe("colors", () => {
  /** Art drawn in markup, which keeps its colors in every theme like the art palettes. */
  const ALLOWED: Allowed = {
    // The potion's shine and bubbles are light on its liquid in every theme.
    "apps/web/src/components/usage/potion.tsx": ["bg-white"],
    // The names of the terminal's ANSI colors, which it reads from its `--color-term-*` tokens.
    "apps/web/src/components/terminal/terminal-options.ts": ["bright-black", "bright-white"],
  };

  it("are never hex, rgb(), black or white outside the token blocks and the art palettes", () => {
    const literal =
      /#[0-9a-f]{3,8}(?![\w-])|rgba?\(|(?<![\w-])(?:[a-z]+-)+(?:black|white)(?![\w-])|:\s*(?:black|white)\b/gi;
    expect(breaks(literal, { include: (path) => !ART.test(path), allowed: ALLOWED })).toEqual([]);
  });
});

describe("type", () => {
  it("sets no text below the 12px floor", () => {
    const small = /(?<![\w-])text-\[(\d+(?:\.\d+)?)(px|rem)\]|font-size:\s*(\d+(?:\.\d+)?)px/g;
    const below = sources.flatMap(({ path, code }) =>
      [...code.matchAll(small)]
        .filter(([, size = "", unit, cssPx]) =>
          cssPx === undefined ? Number(size) * (unit === "rem" ? 16 : 1) < 12 : Number(cssPx) < 12,
        )
        .map(([match]) => `${path}: ${match}`),
    );
    expect(below).toEqual([]);
  });

  it("uses the scale where it replaces Tailwind's sizes: meta, ui, reading and title", () => {
    // text-xl and up have no step in the scale yet; they size glyphs and pairing codes.
    expect(breaks(cls("text-(?:xs|sm|base|lg)"))).toEqual([]);
  });
});

describe("corners", () => {
  /*
   * Shapes fixed by design (docs/design/themes.md, Shape): speech bubbles with their tail corner,
   * ellipses, art drawn in markup, and marks smaller than a tag. Everything else reads the skin
   * through rounded-control, rounded-card, rounded-tag, rounded-dot, rounded-tile or cut.
   */
  const ALLOWED: Allowed = {
    "apps/web/src/components/chat-search/chat-search.tsx": ["rounded-[3px]"],
    "apps/web/src/components/chat/empty-thread.tsx": ["rounded-[12px_12px_12px_2px]"],
    "apps/web/src/components/hob-page/chat-row.tsx": ["rounded-[3px]"],
    "apps/web/src/components/hob-page/hob-aside.tsx": ["rounded-[2px]"],
    "apps/web/src/components/hob-page/hob-hero.tsx": ["rounded-[50%]", "rounded-xl", "rounded-ss-[2px]"],
    "apps/web/src/components/hob-page/hob-history.tsx": ["rounded-[3px]"],
    "apps/web/src/components/hobs-page/hob-card.tsx": ["rounded-[2px]"],
    "apps/web/src/components/inbox/inbox-detail.tsx": ["rounded-[4px_14px_14px_14px]"],
    "apps/web/src/components/inbox/inbox-page.tsx": ["rounded-[12px_12px_12px_2px]"],
    "apps/web/src/components/onboarding/first-arrived.tsx": [
      "rounded-[12px_12px_2px_12px]",
      "rounded-[12px_12px_12px_2px]",
    ],
    "apps/web/src/components/onboarding/onboarding-frame.tsx": [
      "rounded-t-[14px]",
      "rounded-[2px]",
      "rounded-[3px]",
      "rounded-[2px_12px_12px_12px]",
    ],
    "apps/web/src/components/onboarding/onboarding-summon.tsx": ["rounded-[50%]"],
    "apps/web/src/components/onboarding/welcome-village.tsx": ["rounded-[12px_12px_12px_2px]"],
    "apps/web/src/components/pairing/device-prompt.tsx": ["rounded-[3px]"],
    "apps/web/src/components/pairing/pairing-screen.tsx": ["rounded-[12px_12px_12px_2px]"],
    // Each look's preview shows that look's own corner.
    "apps/web/src/components/settings/appearance.tsx": ["rounded-[8px]"],
    "apps/web/src/components/summon/summoning.tsx": ["rounded-[50%]"],
    "apps/web/src/components/usage/hob-breakdown.tsx": ["rounded-t-[4px]"],
    "apps/web/src/components/usage/potion.tsx": [
      "rounded-t-[3px]",
      "rounded-[26px_26px_20px_20px]",
      "rounded-[4px]",
      "rounded-[9px_9px_7px_7px]",
    ],
    "apps/web/src/components/usage/usage-page.tsx": ["rounded-[3px]"],
    "apps/web/src/components/workbench/changes/mark-changes.ts": ["rounded-sm"],
    "packages/ui/src/components/search-field.tsx": ["rounded-[4px]"],
  };

  it("are never fixed, apart from the shapes fixed by design", () => {
    // An arbitrary corner may still derive from the skin, such as calc(var(--corner-control)*3/8).
    const fixed = cls(
      "(?:[a-z]+:)*rounded(?:-[trblse]{1,2})?-(?:xs|sm|md|lg|xl|[234]xl|\\[(?![^\\]]*var\\(--corner-)(?!inherit\\])[^\\]]+\\])",
    );
    expect(breaks(fixed, { allowed: ALLOWED })).toEqual([]);
  });

  it("are never set from shadcn's --radius, which the themes do not set", () => {
    expect(breaks(/--radius(?![\w-])/g)).toEqual([]);
  });

  it("keep every allowed shape in use, so the list stays true", () => {
    const stale = Object.entries(ALLOWED).flatMap(([path, matches]) => {
      const code = sources.find((source) => source.path === path)?.code ?? "";
      return matches.filter((match) => !code.includes(match)).map((match) => `${path}: ${match}`);
    });
    expect(stale).toEqual([]);
  });
});

describe("edges", () => {
  it("take the skin's edge, border-(length:--edge), never a fixed 2px border", () => {
    expect(breaks(cls("(?:[a-z-]+:)*border(?:-[xytblrse])?-(?:2|\\[2px\\])"))).toEqual([]);
  });
});

describe("motion", () => {
  it("times transitions with the duration tokens, duration-(--dur-*), never a literal duration", () => {
    expect(breaks(cls("(?:[a-z-]+:)*duration-(?:\\d+|\\[[^\\]]+\\])"))).toEqual([]);
  });

  it("animates only with the --animate-hb-* tokens", () => {
    // animate-in and animate-out are tw-animate-css enter and exit, timed by duration-(--dur-*);
    // animate-(--hop) is the skin's hop and animate-none stops an animation.
    const animate = cls(
      "(?:[a-z-]+:|\\[[^\\]]+\\]:)*animate-(?!hb-|in(?![\\w-])|out(?![\\w-])|none(?![\\w-])|\\(--hop\\))[\\w-]+",
    );
    expect(breaks(animate)).toEqual([]);
  });

  it("sets no literal duration on an animation or transition in the stylesheets", () => {
    const literal =
      /(?<![\w-])(?:animation|transition)(?:-duration)?:[^;{}]*?(?<![\w.-])(?:0*[1-9]\d*(?:\.\d+)?|0*\.\d*[1-9]\d*)m?s\b/g;
    expect(breaks(literal, { include: (path) => path.endsWith(".css") })).toEqual([]);
  });
});

describe("@theme", () => {
  const css = readFileSync(new URL("./src/styles.css", import.meta.url), "utf8");
  const theme = [...css.matchAll(/^@theme\s*\{\n([\s\S]*?)^\}/gm)].map(([, body = ""]) => body).join("\n");
  /** Each custom property in @theme that starts with `prefix`, as its name after the prefix and its value. */
  const tokens = (prefix: string) =>
    Object.fromEntries(
      [...theme.matchAll(new RegExp(`^\\s*${prefix}([\\w-]+):\\s*([^;]+);`, "gm"))].map(([, name = "", value = ""]) => [
        name,
        value,
      ]),
    );

  it("sets every type size from themes.json and no other", () => {
    const sizes = Object.fromEntries(
      Object.entries(tokens("--text-")).filter(([name]) => !name.endsWith("--line-height")),
    );
    const expected = Object.fromEntries(
      Object.entries(themes.type)
        .filter(([style]) => style !== "label")
        .map(([style, { size }]) => [style, size]),
    );
    expect(sizes).toEqual(expected);
  });

  it("sets every duration from themes.json and no other", () => {
    const durations = Object.fromEntries(Object.entries(tokens("--")).filter(([name]) => name.startsWith("dur-")));
    expect(durations).toEqual(themes.duration);
  });

  it("sets only fonts from themes.json, each with its stack", () => {
    for (const [family, stack] of Object.entries(tokens("--font-"))) expect(stack, family).toBe(themes.font[family]);
  });

  it("sets every size from themes.json and no other", () => {
    expect(tokens("--spacing-")).toEqual(themes.size);
  });
});
