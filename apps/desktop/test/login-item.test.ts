import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { handleLoginItemIpc, type LoginItems, loginItemChannels, makeLoginItem } from "../src/main/login-item.ts";
import { fileSettingsStore } from "../src/main/settings.ts";

const temp = mkdtempSync(join(tmpdir(), "hobbots-login-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let files = 0;
const freshSettings = () => fileSettingsStore(join(temp, `settings-${files++}.json`));

/** macOS's login items as SMAppService reports them; `refuse` stands for an ad-hoc build it ignores. */
const fakeMac = (options: { status?: string; wasOpenedAtLogin?: boolean; refuse?: boolean } = {}) => {
  let status = options.status ?? "not-registered";
  const writes: boolean[] = [];
  const items: LoginItems = {
    read: () => ({ status, wasOpenedAtLogin: options.wasOpenedAtLogin ?? false }),
    write: (on) => {
      writes.push(on);
      if (!options.refuse) status = on ? "enabled" : "not-registered";
    },
  };
  return { items, writes };
};

describe("the login item", () => {
  // covers EX-005
  it("[TC-GEN-004] registers on the first start, because opening at login is on by default", () => {
    const mac = fakeMac();
    const settings = freshSettings();
    const item = makeLoginItem({ supported: true, items: mac.items, settings });
    expect(mac.writes).toEqual([true]);
    expect(item.state()).toEqual({ openAtLogin: true, status: "enabled" });
    // Already registered: the next start leaves it alone.
    makeLoginItem({ supported: true, items: mac.items, settings });
    expect(mac.writes).toEqual([true]);
  });

  // covers EX-005
  it("[TC-GEN-005] removes the login item when the switch is turned off, and remembers it", () => {
    const mac = fakeMac();
    const settings = freshSettings();
    const item = makeLoginItem({ supported: true, items: mac.items, settings });
    expect(item.setOpenAtLogin(false)).toEqual({ openAtLogin: false, status: "not-registered" });
    expect(mac.writes).toEqual([true, false]);
    // Turned off stays off after a restart.
    makeLoginItem({ supported: true, items: mac.items, settings });
    expect(mac.writes).toEqual([true, false]);
    expect(item.setOpenAtLogin(true).status).toBe("enabled");
  });

  // covers EX-005, OP-002
  it("[TC-GEN-006] reports what macOS made of the registration instead of assuming it worked", () => {
    const refused = fakeMac({ refuse: true });
    const item = makeLoginItem({ supported: true, items: refused.items, settings: freshSettings() });
    expect(item.setOpenAtLogin(true)).toEqual({ openAtLogin: true, status: "not-registered" });

    const waiting = fakeMac({ status: "requires-approval" });
    const approval = makeLoginItem({ supported: true, items: waiting.items, settings: freshSettings() });
    // The user disabled it in System Settings: theirs to resolve there, not overridden on start.
    expect(waiting.writes).toEqual([]);
    expect(approval.state()).toEqual({ openAtLogin: true, status: "requires-approval" });
  });

  // covers EX-005
  it("[TC-GEN-007] starts without a window only when macOS opened the app at login", () => {
    const atLogin = makeLoginItem({
      supported: true,
      items: fakeMac({ status: "enabled", wasOpenedAtLogin: true }).items,
      settings: freshSettings(),
    });
    expect(atLogin.openedAtLogin).toBe(true);
    const byHand = makeLoginItem({
      supported: true,
      items: fakeMac({ status: "enabled" }).items,
      settings: freshSettings(),
    });
    expect(byHand.openedAtLogin).toBe(false);
  });

  it("never touches macOS from a development checkout", () => {
    const mac = fakeMac({ wasOpenedAtLogin: true });
    const item = makeLoginItem({ supported: false, items: mac.items, settings: freshSettings() });
    expect(item.openedAtLogin).toBe(false);
    expect(item.setOpenAtLogin(false)).toEqual({ openAtLogin: false, status: "unavailable" });
    expect(mac.writes).toEqual([]);
  });

  it("reads a missing or damaged settings file as no choice made", () => {
    const file = join(temp, "damaged.json");
    writeFileSync(file, "{ not json");
    expect(fileSettingsStore(file).read()).toEqual({});
    writeFileSync(file, JSON.stringify({ openAtLogin: "yes" }));
    expect(fileSettingsStore(file).read()).toEqual({});
    expect(fileSettingsStore(join(temp, "missing.json")).read()).toEqual({});
  });

  it("answers the preload bridge only from pages the window may show", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const item = makeLoginItem({ supported: true, items: fakeMac().items, settings: freshSettings() });
    handleLoginItemIpc({
      ipcMain: { handle: (channel, f) => void handlers.set(channel, f as never) },
      loginItem: item,
      isTrusted: (event) => (event as unknown as { trusted: boolean }).trusted,
      openSystemSettings: async () => {},
    });
    const set = handlers.get(loginItemChannels.set);
    expect(() => set?.({ trusted: false }, false)).toThrow();
    expect(item.state().openAtLogin).toBe(true);
    // Anything but `true` turns it off.
    expect(set?.({ trusted: true }, "yes")).toEqual({ openAtLogin: false, status: "not-registered" });
    await expect(handlers.get(loginItemChannels.openSystemSettings)?.({ trusted: true })).resolves.toEqual(
      item.state(),
    );
  });
});
