import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** A hex or rgb() color written into code; a component reads tokens instead (docs/design/themes.md). */
const LITERAL = /#[0-9a-f]{3,8}(?![\w-])|rgba?\(/gi;

/** Comments name issues such as (#386), which read like short hex colors. */
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("hard-coded colors", () => {
  it("leaves none in components, which take them from tokens or from art in src/art", () => {
    const folder = new URL("./src/components/", import.meta.url);
    const found = readdirSync(folder, { recursive: true, encoding: "utf8" })
      .filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path))
      .flatMap((path) =>
        [...withoutComments(readFileSync(new URL(path, folder), "utf8")).matchAll(LITERAL)].map(
          ([literal]) => `${path}: ${literal}`,
        ),
      );
    expect(found).toEqual([]);
  });
});
