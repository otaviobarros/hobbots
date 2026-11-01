import { describe, expect, it } from "vitest";
import { codeLanguage, hastText } from "./hast-text.ts";

const pre = {
  type: "element",
  tagName: "pre",
  children: [
    {
      type: "element",
      tagName: "code",
      properties: { className: ["hljs", "language-ts"] },
      children: [
        { type: "element", tagName: "span", children: [{ type: "text", value: "const" }] },
        { type: "text", value: " a = 1\n" },
      ],
    },
  ],
};

describe("hastText", () => {
  it("reads a highlighted block's text without its spans", () => {
    expect(hastText(pre)).toBe("const a = 1\n");
  });
});

describe("codeLanguage", () => {
  it("reads the language a fence names, or none", () => {
    expect(codeLanguage(pre)).toBe("ts");
    expect(codeLanguage({ type: "element", tagName: "pre", children: [{ type: "element", tagName: "code" }] })).toBe(
      null,
    );
  });
});
