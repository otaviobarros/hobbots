import { describe, expect, it } from "vitest";
import script from "../../public/first-paint.js?raw";
import { resolveTheme, THEMES, type ThemeChoice } from "./theme.ts";

/** Runs public/first-paint.js on a page with this storage, and returns the root's data attributes. */
const firstPaint = ({
  stored = {},
  systemDark = false,
  hash = "",
  desktop = false,
}: {
  stored?: Record<string, string>;
  systemDark?: boolean;
  hash?: string;
  desktop?: boolean;
}) => {
  const dataset: Record<string, string> = { theme: "workshop-night" };
  const page = {
    localStorage: { getItem: (key: string) => stored[key] ?? null },
    matchMedia: () => ({ matches: systemDark }),
    location: { hash },
    hobbots: desktop ? {} : undefined,
  };
  // The script reads only the page it is given, never the test's own globals.
  new Function("window", "document", script)(page, { documentElement: { dataset } });
  return dataset;
};

const CHOICES: ReadonlyArray<ThemeChoice> = [...THEMES, "lamplight-auto", "workshop-auto"];

describe("first paint", () => {
  it("shows the theme the app will, for every choice and system mode", () => {
    for (const choice of CHOICES) {
      for (const systemDark of [true, false]) {
        const { theme } = firstPaint({ stored: { "hobbots.theme": JSON.stringify(choice) }, systemDark });
        expect(theme, `${choice}, system dark: ${systemDark}`).toBe(resolveTheme(choice, systemDark));
      }
    }
  });

  it("keeps first run's theme when nothing or something unknown is saved", () => {
    expect(firstPaint({}).theme).toBe("workshop-night");
    expect(firstPaint({ stored: { "hobbots.theme": '"neon"' } }).theme).toBe("workshop-night");
    expect(firstPaint({ stored: { "hobbots.theme": "not json" } }).theme).toBe("workshop-night");
  });

  it("opens the sidebar only when this device keeps it open", () => {
    expect(firstPaint({ stored: { "sidebar.open": "true" } }).sidebar).toBe("open");
    expect(firstPaint({ stored: { "sidebar.open": "false" } }).sidebar).toBeUndefined();
    expect(firstPaint({}).sidebar).toBeUndefined();
  });

  it("draws the title strip only in the desktop window", () => {
    expect(firstPaint({ desktop: true }).window).toBe("desktop");
    expect(firstPaint({}).window).toBeUndefined();
  });

  it("leaves the sidebar out of setup, Welcome and pairing", () => {
    for (const hash of ["#/welcome", "#/setup/providers", "#/pair", "#/pair?code=1"]) {
      expect(firstPaint({ hash }).frame, hash).toBe("plain");
    }
    for (const hash of ["", "#/", "#/hobs", "#/settings/setup", "#/pairing-help"]) {
      expect(firstPaint({ hash }).frame, hash).toBeUndefined();
    }
  });
});
