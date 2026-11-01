import { describe, expect, it } from "vitest";
import { safeUrl, shownUrl, showsItsUrl } from "./links.ts";

describe("safeUrl", () => {
  it("keeps web addresses and drops every other kind", () => {
    expect(safeUrl("https://hobbots.ai/docs")).toBe("https://hobbots.ai/docs");
    expect(safeUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(safeUrl("javascript:alert(1)")).toBe("");
    expect(safeUrl("file:///etc/passwd")).toBe("");
    expect(safeUrl("#/hobs")).toBe("");
    expect(safeUrl("streamdown:incomplete-image")).toBe("");
  });
});

describe("shownUrl", () => {
  it("shows the host and path, without https or a trailing slash", () => {
    expect(shownUrl("https://hobbots.ai/")).toBe("hobbots.ai");
    expect(shownUrl("https://example.com/guide")).toBe("example.com/guide");
    expect(shownUrl("http://example.com/guide")).toBe("http://example.com/guide");
  });

  it("always shows the whole host, shortening only a long path", () => {
    const host = "accounts.google.com.signin-verify-session.example";
    const shown = shownUrl(`https://${host}/login/${"a".repeat(80)}/end?x=1`);
    expect(shown.startsWith(`${host}/login`)).toBe(true);
    expect(shown).toMatch(/…a+\/end\?x=1$/);
  });

  it("shows look-alike letters as punycode and drops a user@ prefix", () => {
    expect(shownUrl("https://\u0430pple.com")).toBe("xn--pple-43d.com");
    expect(shownUrl("https://google.com@evil.example/")).toBe("evil.example");
  });
});

describe("showsItsUrl", () => {
  it("tells an autolink from a named link", () => {
    expect(showsItsUrl("https://hobbots.ai", "https://hobbots.ai/")).toBe(true);
    expect(showsItsUrl("HTTPS://Hobbots.ai", "https://hobbots.ai")).toBe(true);
    expect(showsItsUrl("hobbots.ai", "https://hobbots.ai")).toBe(true);
    expect(showsItsUrl("the docs", "https://hobbots.ai")).toBe(false);
  });

  it("shows the address when the text names another scheme", () => {
    expect(showsItsUrl("https://bank.com", "http://bank.com")).toBe(false);
  });
});
