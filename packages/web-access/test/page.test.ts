import { describe, expect, it } from "vitest";
import { decodeBody } from "../src/page.ts";

// How web_fetch reads a page's bytes as text (ADR 036).

const bytes = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));

describe("a page's charset", () => {
  it("reads the charset an HTML page names in its own meta tag when the header names none", () => {
    const page = `<html><head><meta name="viewport" content="x"><meta charset="windows-1252"></head><body>café \u0080</body></html>`;
    expect(decodeBody(bytes(page), "html", undefined)).toContain("café €");
    const equiv = `<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"><p>café</p>`;
    expect(decodeBody(bytes(equiv), "html", undefined)).toContain("café");
    expect(decodeBody(new TextEncoder().encode("<p>café</p>"), "html", undefined)).toBe("<p>café</p>");
  });

  it("reads a head full of meta tags in linear time", () => {
    const started = performance.now();
    expect(decodeBody(bytes("<meta".repeat(5_000)), "html", undefined)).toHaveLength(25_000);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
