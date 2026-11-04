import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface ThemeFile {
  readonly themes: readonly { readonly id: string }[];
  readonly color: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly contrast: {
    readonly pairs: readonly { readonly text: string; readonly on: string; readonly floor: number }[];
  };
  readonly type: Readonly<Record<string, { readonly size: string; readonly lineHeight: string }>>;
  readonly space: Readonly<Record<string, string>>;
  readonly duration: Readonly<Record<string, string>>;
  readonly font: Readonly<Record<string, string>>;
  readonly fixed: Readonly<Record<string, { readonly value: string }>>;
  readonly skin: Readonly<Record<string, Readonly<Record<string, string | number>>>>;
  readonly size: Readonly<Record<string, string>>;
}

const themes: ThemeFile = JSON.parse(readFileSync(new URL("../../docs/design/themes.json", import.meta.url), "utf8"));
const css = readFileSync(new URL("./src/styles.css", import.meta.url), "utf8");

/** A channel of an sRGB hex color, linearized as WCAG 2 defines it. */
const linear = (hex: string, at: number): number => {
  const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
};

/** The WCAG 2 relative luminance of a `#rrggbb` color. */
const luminance = (hex: string): number => 0.2126 * linear(hex, 1) + 0.7152 * linear(hex, 3) + 0.0722 * linear(hex, 5);

/** The WCAG 2 contrast ratio of two `#rrggbb` colors, from 1 to 21. */
const contrast = (a: string, b: string): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
};

describe("contrast", () => {
  it("measures known pairs", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  it.each(themes.themes)("$id meets every floor", (theme) => {
    const color = (token: string) => {
      const value = themes.color[token]?.[theme.id];
      expect(value, token).toMatch(/^#[0-9a-f]{6}$/i);
      return value ?? "";
    };
    const below = themes.contrast.pairs
      .map((pair) => ({ ...pair, ratio: contrast(color(pair.text), color(pair.on)) }))
      .filter(({ ratio, floor }) => ratio < floor)
      .map(({ text, on, ratio, floor }) => `${text} on ${on}: ${ratio.toFixed(2)}, floor ${floor}`);
    expect(below).toEqual([]);
  });
});

/** The body of every top-level rule whose selector matches `selector`. A body ends at a `}` on its own line. */
const rulesMatching = (selector: RegExp): string[] =>
  [...css.matchAll(/^([^\s{}/*][^{}\n]*)\{\n([\s\S]*?)^\}/gm)]
    .filter(([, head = ""]) => selector.test(head.trim()))
    .map(([, , body = ""]) => body);

describe("type scale and spacing", () => {
  const theme = rulesMatching(/^@theme$/).join("\n");

  it.each(Object.entries(themes.type).filter(([style]) => style !== "label"))(
    "%s is set in @theme with its size and line height",
    (style, { size, lineHeight }) => {
      expect(theme).toContain(`--text-${style}: ${size};`);
      expect(theme).toContain(`--text-${style}--line-height: ${lineHeight};`);
    },
  );

  it("keeps the label style in the lbl utility", () => {
    expect(rulesMatching(/^@utility lbl$/).join("")).toContain(`font-size: ${themes.type.label?.size};`);
  });

  it("sets no text below the 12px floor", () => {
    const sizes = [...theme.matchAll(/--text-[\w-]+(?<!--line-height):\s*(\d+)px;/g)].map(([, px]) => Number(px));
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.filter((px) => px < 12)).toEqual([]);
  });

  it("keeps every space step on Tailwind's grid", () => {
    expect(theme).not.toMatch(/--spacing:/);
    for (const [step, value] of Object.entries(themes.space)) expect(Number.parseFloat(value) % 2, step).toBe(0);
  });

  it.each(Object.entries(themes.duration))("%s is set in @theme", (token, value) => {
    expect(theme).toContain(`--${token}: ${value};`);
  });

  it.each(["sans", "pixel", "mono"])("sets the %s font stack from themes.json", (family) => {
    expect(theme).toContain(`--font-${family}: ${themes.font[family]};`);
  });

  it("sets the fixed segment shadow in @theme", () => {
    expect(theme).toContain(`--shadow-segment: ${themes.fixed["shadow-segment"]?.value};`);
  });

  it("draws a 2px focus ring in every look", () => {
    for (const look of Object.values(themes.skin)) expect(look["focus-outline"]).toBe("2px solid focus-ring");
    const widths = [...css.matchAll(/--focus-width:\s*([^;]+);/g)].map(([, value]) => value);
    expect(widths).toEqual(["2px", "2px"]);
  });

  it.each(Object.entries(themes.size))("%s is set in @theme", (size, value) => {
    expect(theme).toContain(`--spacing-${size}: ${value};`);
  });

  it("sets no size in @theme that themes.json lacks", () => {
    const sizes = [...theme.matchAll(/--spacing-([\w-]+):/g)].map(([, name]) => name);
    expect(sizes.filter((name) => name !== undefined && !(name in themes.size))).toEqual([]);
  });

  it("lets no theme or look change type, spacing or sizes", () => {
    const themed = rulesMatching(/data-theme/).join("\n");
    expect(themed).not.toMatch(/--text-|--spacing|font-size|line-height|letter-spacing/);
  });
});
