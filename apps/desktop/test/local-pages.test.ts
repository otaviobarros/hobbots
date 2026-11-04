import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { LOCAL_ORIGIN, localPageResponse } from "../src/main/local-pages.ts";

const temp = mkdtempSync(join(tmpdir(), "hobbots-local-pages-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const root = join(temp, "web");
mkdirSync(join(root, "assets"), { recursive: true });
writeFileSync(join(root, "local.html"), "<!doctype html><title>Setup</title>");
writeFileSync(join(root, "assets", "local.js"), "console.log('setup');");
writeFileSync(join(temp, "secret.txt"), "not for the page");

/** Reads a `file:` URL as Electron's `net.fetch` would, recording what was asked for. */
const fetched: string[] = [];
const respond = localPageResponse(root, async (url) => {
  fetched.push(url);
  return new Response(readFileSync(fileURLToPath(url)));
});

describe("the local pages' protocol handler (STD-DESKTOP-006)", () => {
  it("serves the local pages and their assets from the app's own folder", async () => {
    expect(await (await respond({ url: `${LOCAL_ORIGIN}/` })).text()).toContain("<title>Setup</title>");
    expect(await (await respond({ url: `${LOCAL_ORIGIN}/?start=where` })).text()).toContain("Setup");
    expect(await (await respond({ url: `${LOCAL_ORIGIN}/assets/local.js` })).text()).toContain("setup");
  });

  it("answers 404 for anything outside the folder, another host, or a file that is missing", async () => {
    fetched.length = 0;
    for (const url of [
      `${LOCAL_ORIGIN}/../secret.txt`,
      `${LOCAL_ORIGIN}/%2e%2e/secret.txt`,
      `${LOCAL_ORIGIN}/assets/%2e%2e%2f%2e%2e%2fsecret.txt`,
      "hobbots://other/local.html",
      "file:///etc/passwd",
      "not a url",
    ]) {
      expect((await respond({ url })).status).toBe(404);
    }
    // A URL resolves `..` before the handler sees it, so the most it reaches is a missing file inside the folder.
    const inside = `${new URL(`file://${root}/`).href}`;
    expect(fetched.every((url) => url.startsWith(inside))).toBe(true);
    expect((await respond({ url: `${LOCAL_ORIGIN}/assets/missing.js` })).status).toBe(404);
  });
});
