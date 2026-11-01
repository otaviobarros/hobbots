import { describe, expect, it } from "vitest";
import { holdBackPartialTable, streamingMarkdown } from "./streaming.ts";

describe("holdBackPartialTable", () => {
  it("holds back a table header until its row of dashes arrives", () => {
    expect(holdBackPartialTable("Results:\n\n| Name | Score |\n")).toBe("Results:\n\n");
    expect(holdBackPartialTable("Results:\n\n| Name | Sc")).toBe("Results:\n\n");
  });

  it("shows a table once its header and dashes are in, holding back a row still being written", () => {
    const table = "| Name | Score |\n| --- | ---: |\n| Pip | 3 |\n";
    expect(holdBackPartialTable(table)).toBe(table);
    expect(holdBackPartialTable(`${table}| Moss | 4`)).toBe(table);
  });

  it("never holds back pipes inside a code block", () => {
    const code = "```sh\nls | wc -l\n| sort";
    expect(holdBackPartialTable(code)).toBe(code);
  });

  it("leaves text without a table alone", () => {
    expect(holdBackPartialTable("Hello\n\nworld")).toBe("Hello\n\nworld");
  });
});

describe("streamingMarkdown", () => {
  it("closes emphasis and inline code that are still open", () => {
    expect(streamingMarkdown("This is **bold")).toBe("This is **bold**");
    expect(streamingMarkdown("Run `pnpm che")).toBe("Run `pnpm che`");
  });

  it("shows a link that is still arriving as its text", () => {
    expect(streamingMarkdown("See [the docs](https://exam")).toBe("See the docs");
  });
});

describe("holdBackPartialTable, harder tables", () => {
  it("holds back a header without outer pipes, and one inside a quote", () => {
    expect(holdBackPartialTable("Results:\n\nName | Score\n")).toBe("Results:\n\n");
    expect(holdBackPartialTable("> | Name | Score |\n")).toBe("");
    expect(holdBackPartialTable("Name | Score\n--- | ---\n")).toBe("Name | Score\n--- | ---\n");
  });

  it("closes a fence only on a matching one", () => {
    expect(holdBackPartialTable("~~~\n```\n~~~\n| a |\n")).toBe("~~~\n```\n~~~\n");
    expect(holdBackPartialTable("````md\n```\n| a |\n")).toBe("````md\n```\n| a |\n");
  });

  it("keeps pipes in a code block indented inside a list item", () => {
    const text = "1. Run:\n\n    ```sh\n    ls\n    | sort";
    expect(holdBackPartialTable(text)).toBe(text);
  });
});

describe("holdBackPartialTable, chunk by chunk", () => {
  it("keeps a header without outer pipes hidden while its delimiter row arrives", () => {
    const full = "Results:\n\nName | Score\n--- | ---\nPip | 3\n";
    // From the first pipe, the line may be a table header.
    const header = full.indexOf("|") + 1;
    const delimiterEnd = full.indexOf("Pip");
    for (let cut = header; cut < delimiterEnd; cut += 1) {
      expect(holdBackPartialTable(full.slice(0, cut)), `after ${JSON.stringify(full.slice(0, cut))}`).toBe(
        "Results:\n\n",
      );
    }
    expect(holdBackPartialTable(full.slice(0, delimiterEnd))).toBe("Results:\n\nName | Score\n--- | ---\n");
  });

  it("never shows a header without its delimiter row, at any cut", () => {
    for (const full of ["| Hob | Task |\n| --- | --- |\n| Pip | Writing |\n", "> | Hob | Task |\n> | :-- | --: |\n"]) {
      for (let cut = 1; cut <= full.length; cut += 1) {
        const shown = holdBackPartialTable(full.slice(0, cut));
        if (shown.includes("Hob")) expect(shown, `after ${JSON.stringify(full.slice(0, cut))}`).toMatch(/-- \|/);
      }
    }
  });

  it("keeps code with pipes visible inside a quoted code block", () => {
    const text = "> ```sh\n> ls | wc -l\n";
    expect(holdBackPartialTable(text)).toBe(text);
    expect(holdBackPartialTable("> ```sh\n> ls | wc -l")).toBe("> ```sh\n> ls | wc -l");
  });
});
