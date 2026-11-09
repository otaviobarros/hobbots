import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// web_fetch from a bundle (ADR 036): the desktop app and the server's build bundle every dependency,
// undici included, so the fetcher is built the same way here and reads a page from the bundle.

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("Read from the bundle.");
});
const out = mkdtempSync(join(tmpdir(), "hobbots-bundled-fetch-"));
let port = 0;

beforeAll(async () => {
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  port = (site.address() as AddressInfo).port;
});
afterAll(() => {
  site.close();
  rmSync(out, { recursive: true, force: true });
});

describe("web_fetch in a bundle", () => {
  // covers ADR 036 (Reading a page)
  it("[TC-PE-1267-21] reads a page when the fetcher and undici are bundled into one file, as the desktop app runs it", {
    timeout: 60_000,
  }, async () => {
    await build({
      configFile: false,
      logLevel: "silent",
      build: {
        ssr: resolve(import.meta.dirname, "fixtures/bundled-web-fetch.ts"),
        outDir: out,
        target: "node26",
        minify: false,
      },
      ssr: { noExternal: true },
    });
    const bundle = (await import(pathToFileURL(join(out, "bundled-web-fetch.js")).href)) as {
      readonly readOnce: (url: string) => Promise<{ readonly _tag: string; readonly page?: { readonly text: string } }>;
    };
    const read = await bundle.readOnce(`http://site.test:${port}/notes.txt`);
    expect(read).toMatchObject({ _tag: "Page", page: { text: "Read from the bundle." } });
  });
});
