import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fetchAsWindow, makeWindowKey } from "../src/main/window-key.ts";

const temp = mkdtempSync(join(tmpdir(), "hobbots-window-key-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const keyFile = join(temp, "window-key");

describe("the window key", () => {
  // covers DP-004
  it("[TC-DP-085] sends the key the hub wrote, and after a 401 reads it again, sets the cookie again and retries once", async () => {
    writeFileSync(keyFile, "hbw_first\n");
    const key = makeWindowKey(temp);
    expect(key.headers()).toEqual({ authorization: "Bearer hbw_first" });

    // The hub restarted with a new key: the old one is refused.
    writeFileSync(keyFile, "hbw_second\n");
    const sent: Array<string | null> = [];
    let renewed = 0;
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      sent.push(authorization);
      return new Response(null, { status: authorization === "Bearer hbw_second" ? 200 : 401 });
    };
    const fetchHub = fetchAsWindow(key, () => renewed++, fetcher as typeof fetch);
    expect((await fetchHub("http://127.0.0.1:4317/api/activity")).status).toBe(200);
    expect(sent).toEqual(["Bearer hbw_first", "Bearer hbw_second"]);
    expect(renewed).toBe(1);

    // A 401 with the key unchanged is the answer: no second try.
    writeFileSync(keyFile, "hbw_third\n");
    key.reload();
    sent.length = 0;
    expect((await fetchHub("http://127.0.0.1:4317/api/activity")).status).toBe(401);
    expect(sent).toEqual(["Bearer hbw_third"]);
    expect(renewed).toBe(1);
  });

  it("has no key, and sends none, while the hub has written none", () => {
    const key = makeWindowKey(join(temp, "missing"));
    expect(key.current()).toBeUndefined();
    expect(key.headers()).toEqual({});
  });
});
