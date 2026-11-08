import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appWebPreferences, browserUrl, navigationGuard, windowOpenHandler } from "../src/main/window-policy.ts";

describe("a window's page", () => {
  it("is isolated and sandboxed, with no Node.js, no webview and the browser's own security (STD-DESKTOP-001)", () => {
    const preferences = appWebPreferences("/app/preload/index.cjs", ["--hobbots-mode=setup"]);
    expect(preferences).toMatchObject({
      preload: "/app/preload/index.cjs",
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      additionalArguments: ["--hobbots-mode=setup"],
    });
    expect(preferences).not.toHaveProperty("enableBlinkFeatures");
  });
});

describe("where a window may go (STD-DESKTOP-004)", () => {
  it("opens only http and https links in the browser, as parsed", () => {
    expect(browserUrl("https://hobbots.app/docs")).toBe("https://hobbots.app/docs");
    expect(browserUrl("http://studio.example.ts.net:4317/")).toBe("http://studio.example.ts.net:4317/");
    expect(browserUrl("HTTPS://Example.com/a b")).toBe("https://example.com/a%20b");
    for (const url of [
      "file:///etc/passwd",
      "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
      "httpx://example.com",
      "javascript:alert(1)",
      "smb://share/folder",
      "/relative/path",
      "not a url",
    ]) {
      expect(browserUrl(url)).toBeNull();
    }
  });

  it("never opens a new window, and hands a web link to the browser", async () => {
    const opened: string[] = [];
    const handler = windowOpenHandler(async (url) => void opened.push(url));
    expect(handler({ url: "https://hobbots.app/" })).toEqual({ action: "deny" });
    expect(handler({ url: "file:///Applications/Calculator.app" })).toEqual({ action: "deny" });
    expect(opened).toEqual(["https://hobbots.app/"]);
    // A browser that cannot be opened leaves nothing unhandled.
    const failing = windowOpenHandler(() => Promise.reject(new Error("no browser")));
    expect(failing({ url: "https://hobbots.app/" })).toEqual({ action: "deny" });
  });

  it("stops a navigation or a redirect to any page the window may not show", () => {
    const guard = navigationGuard((url) => url.startsWith("http://127.0.0.1:4317/"));
    const allowed = { preventDefault: vi.fn() };
    const refused = { preventDefault: vi.fn() };
    guard(allowed, "http://127.0.0.1:4317/hobs");
    guard(refused, "https://example.com/");
    expect(allowed.preventDefault).not.toHaveBeenCalled();
    expect(refused.preventDefault).toHaveBeenCalledOnce();
  });
});

describe("the web client's pages (STD-DESKTOP-006)", () => {
  const policyOf = (page: string) => {
    const html = readFileSync(join(import.meta.dirname, "../../web", page), "utf8");
    return html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  };

  it.each(["index.html", "local.html"])("%s allows scripts only from its own origin", (page) => {
    const policy = policyOf(page);
    expect(policy).toBeDefined();
    const directives = new Map(
      (policy ?? "").split(";").map((part) => {
        const [name = "", ...values] = part.trim().split(/\s+/);
        return [name, values] as const;
      }),
    );
    const scripts = directives.get("script-src") ?? directives.get("default-src");
    expect(scripts).toEqual(["'self'"]);
    expect(directives.has("script-src-elem")).toBe(false);
  });
});
