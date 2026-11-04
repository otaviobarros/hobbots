import { readdirSync, readFileSync } from "node:fs";
import { THEME_CORNERS, THEME_TEXT_STYLES } from "@hobbots/ui/lib/utils";
import { describe, expect, it } from "vitest";
import { THEMES } from "./src/lib/theme.ts";

type PerTheme = Readonly<Record<string, string>>;

interface ThemeFile {
  readonly themes: readonly { readonly id: string; readonly default: boolean }[];
  readonly color: Readonly<Record<string, PerTheme>>;
  readonly shadow: Readonly<Record<string, PerTheme>>;
}

const themes: ThemeFile = JSON.parse(readFileSync(new URL("../../docs/design/themes.json", import.meta.url), "utf8"));
const css = readFileSync(new URL("./src/styles.css", import.meta.url), "utf8");

/** The custom properties set by every top-level rule whose selector is `selector`, by name. */
const declarations = (selector: string): Map<string, string> => {
  const values = new Map<string, string>();
  for (const rule of css.split(`\n${selector} {`).slice(1)) {
    const body = rule.slice(0, rule.indexOf("\n}"));
    for (const [, name = "", value = ""] of body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) values.set(name, value);
  }
  expect(values.size, `no rule for ${selector}`).toBeGreaterThan(0);
  return values;
};

/** What a theme sets: the default theme lives in @theme and the :root rule, the others in their own rule. */
const themeValues = (id: string, isDefault: boolean): Map<string, string> =>
  isDefault
    ? new Map([...declarations("@theme"), ...declarations(":root")])
    : declarations(`:root[data-theme="${id}"]`);

describe("themes", () => {
  it.each(themes.themes)("$id sets every color and shadow token to its value in themes.json", (theme) => {
    const values = themeValues(theme.id, theme.default);
    for (const [token, perTheme] of Object.entries(themes.color)) {
      expect(values.get(`--color-${token}`), token).toBe(perTheme[theme.id]);
    }
    for (const [token, perTheme] of Object.entries(themes.shadow)) {
      expect(values.get(`--${token}`), token).toBe(perTheme[theme.id]);
    }
  });

  it("are the themes the app can save", () => {
    expect([...THEMES]).toEqual(themes.themes.map(({ id }) => id));
  });

  it("sets each look's skin in full", () => {
    const lamplight = declarations(":root");
    const workshop = declarations(':root[data-theme^="workshop-"]');
    const skin = (values: Map<string, string>) => [...values.keys()].filter((name) => !name.startsWith("--shadow-"));
    expect(skin(workshop)).toEqual(skin(lamplight));
    expect(workshop.get("--corner-card")).toBe("0");
    expect(lamplight.get("--corner-card")).toBe("16px");
  });

  it("names every type style and corner to the class merger", () => {
    const names = (prefix: string) =>
      [...declarations("@theme").keys(), ...declarations("@theme inline").keys()]
        .filter((name) => name.startsWith(prefix) && !name.endsWith("--line-height"))
        .map((name) => name.slice(prefix.length));
    expect(THEME_TEXT_STYLES).toEqual(names("--text-"));
    expect(THEME_CORNERS).toEqual(names("--radius-"));
  });
});

/** Token names the themes renamed (docs/design/themes.md); a new use would read nothing. */
const RENAMED = /(secondary-text|lantern-shadow|shadow-drawer)(?![\w-])/;

/** Every style or component source under a folder, as a path and its text. */
const sources = (folder: URL): [string, string][] =>
  readdirSync(folder, { recursive: true, encoding: "utf8" })
    .filter((path) => /\.(tsx?|css)$/.test(path))
    .map((path) => [path, readFileSync(new URL(path, folder), "utf8")]);

describe("renamed tokens", () => {
  it.each([
    ["apps/web/src", new URL("./src/", import.meta.url)],
    ["packages/ui/src", new URL("../../packages/ui/src/", import.meta.url)],
  ])("%s uses none of the old names", (_, folder) => {
    const stale = sources(folder)
      .filter(([, text]) => RENAMED.test(text))
      .map(([path, text]) => `${path}: ${text.match(RENAMED)?.[1]}`);
    expect(stale).toEqual([]);
  });
});
