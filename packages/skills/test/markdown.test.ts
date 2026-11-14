import { describe, expect, it } from "vitest";
import { rewriteSetLinks, setLinksOf } from "../src/check.ts";
import { readSkillMarkdown } from "../src/markdown.ts";

// A skill's files read as CommonMark (STD-DUP-008): links, reference definitions and front matter.

const targets = (path: string, text: string) => readSkillMarkdown(path, text).links.map((link) => link.target);

describe("a skill's Markdown", () => {
  it("reads links, images, reference definitions, autolinks and raw HTML, and nothing in code", () => {
    const text = [
      'See [rules](../shared/rules.md "Rules") and ![logo](<img/logo one.png>).',
      "",
      "[ref]: <docs/ref.md>",
      '<file:///etc/passwd> and <img src="pic.png">',
      "",
      "`[span](span.md)` and",
      "",
      "    [indented](indented.md)",
      "",
      "> ```",
      "> [fenced](fenced.md)",
      "> ```",
    ].join("\n");
    expect(targets("SKILL.md", text)).toEqual([
      "../shared/rules.md",
      "img/logo one.png",
      "docs/ref.md",
      "file:///etc/passwd",
      "pic.png",
    ]);
  });

  it("reads every src and href of a file that is not Markdown", () => {
    expect(targets("page.html", '<a href="../out.html">x</a>\n\n    <img src="in.png">')).toEqual([
      "../out.html",
      "in.png",
    ]);
  });

  it("reads front matter, with or without a byte order mark, and the text after it", () => {
    expect(readSkillMarkdown("SKILL.md", "\uFEFF---\r\nname: a\n\ndescription: b\n---  \nBody [x](y.md)\n")).toEqual({
      frontMatter: { yaml: "name: a\n\ndescription: b", rest: "Body [x](y.md)\n" },
      links: [{ from: 44, to: 48, target: "y.md" }],
    });
    expect(readSkillMarkdown("SKILL.md", "---\n---\nBody").frontMatter).toEqual({ yaml: "", rest: "Body" });
    expect(readSkillMarkdown("SKILL.md", "Body\n---\nname: a\n---\n").frontMatter).toBeNull();
  });

  it("points only real links elsewhere, keeping anchors, and finds a set's links outside code", () => {
    const text = "\uFEFF[a](../b/x.md#top) `[c](../b/x.md)`\n\n[d]: ../b/x.md\n";
    expect(setLinksOf("a/SKILL.md", text)).toEqual(["b/x.md"]);
    expect(rewriteSetLinks("a/SKILL.md", text, () => "x.md")).toBe(
      "\uFEFF[a](x.md#top) `[c](../b/x.md)`\n\n[d]: x.md\n",
    );
  });
});
