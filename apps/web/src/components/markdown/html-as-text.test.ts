import { describe, expect, it } from "vitest";
import { remarkHtmlAsText } from "./html-as-text.ts";

describe("remarkHtmlAsText", () => {
  it("turns inline HTML into text in its paragraph", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "html", value: "<b>" },
            { type: "text", value: "hi" },
          ],
        },
      ],
    };
    remarkHtmlAsText()(tree);
    expect(tree.children[0]?.children).toEqual([
      { type: "text", value: "<b>" },
      { type: "text", value: "hi" },
    ]);
  });

  it("turns block HTML, such as a script, into a paragraph that keeps its line breaks", () => {
    const tree = { type: "root", children: [{ type: "html", value: "<script>\nalert(1)\n</script>" }] };
    remarkHtmlAsText()(tree);
    expect(tree.children).toEqual([
      {
        type: "paragraph",
        children: [{ type: "text", value: "<script>\nalert(1)\n</script>" }],
        data: { hProperties: { className: ["whitespace-pre-wrap"] } },
      },
    ]);
  });
});
