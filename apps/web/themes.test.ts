import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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

  it("sets each look's skin in full", () => {
    const lamplight = declarations(":root");
    const workshop = declarations(':root[data-theme^="workshop-"]');
    const skin = (values: Map<string, string>) => [...values.keys()].filter((name) => !name.startsWith("--shadow-"));
    expect(skin(workshop)).toEqual(skin(lamplight));
    expect(workshop.get("--corner-card")).toBe("0");
    expect(lamplight.get("--corner-card")).toBe("16px");
  });
});
