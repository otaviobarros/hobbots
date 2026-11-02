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

  // covers no MVP requirement; guards the linear-time pattern rule STD-SEC-005.
  it("[TC-GEN-022] reads a table line full of spaces in linear time", () => {
    // Timed against a line of the same length with no run of spaces, so the budget follows the
    // runner's speed. A pattern that backtracks takes over 100 times as long on the spaces.
    const hostile = `| a | b |\n|-${" ".repeat(100_000)}x |\n`;
    const baseline = `| a | b |\n|-${"a".repeat(100_000)}x |\n`;
    const fastest = (text: string) => {
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 3; run += 1) {
        const started = performance.now();
        expect(holdBackPartialTable(text)).toBe("");
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    fastest(baseline);
    expect(fastest(hostile)).toBeLessThan(fastest(baseline) * 10 + 20);
    expect(holdBackPartialTable("| a | b |\n  |  --- | :-: |  \n")).toBe("| a | b |\n  |  --- | :-: |  \n");
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

  it("keeps a header hidden while indentation and a delimiter row arrive", () => {
    const full = "Name | Score\n  --- | ---\n";
    for (let cut = full.indexOf("\n") + 1; cut < full.length; cut += 1) {
      expect(holdBackPartialTable(full.slice(0, cut)), `after ${JSON.stringify(full.slice(0, cut))}`).toBe("");
    }
    expect(holdBackPartialTable(full)).toBe(full);
  });

  it("keeps lines in an open code block visible, even after a quoted fence inside it", () => {
    const text = "```md\n> ```sh\n> echo hi\n> ```\nls | wc -l\n";
    expect(holdBackPartialTable(text)).toBe(text);
    expect(holdBackPartialTable(`${text}| sort`)).toBe(`${text}| sort`);
  });

  it("keeps code with pipes visible inside a quoted code block", () => {
    const text = "> ```sh\n> ls | wc -l\n";
    expect(holdBackPartialTable(text)).toBe(text);
    expect(holdBackPartialTable("> ```sh\n> ls | wc -l")).toBe("> ```sh\n> ls | wc -l");
  });
});
