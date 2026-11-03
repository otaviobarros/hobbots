import { Device, DeviceId, type RemoteAccessStatus, WINDOW_DEVICE_ID } from "@hobbots/domain";
import { qrRows } from "@hobbots/ui/components/qr-code";
import { describe, expect, it } from "vitest";
import { connectionCalls } from "../../api/connected-desktop.ts";
import { approvedDevices } from "../../api/devices.ts";
import { tailnetName, tailscaleNotReady } from "../remote-access-settings.tsx";
import { versionsLine } from "./connected-hub.tsx";
import { deviceMeta, deviceName } from "./device-meta.ts";
import { typedPort } from "./port-field.tsx";

const now = new Date("2026-11-02T15:00:00Z");

const device = (change: Partial<Device>) =>
  new Device({
    id: DeviceId.make("d1"),
    name: "Safari on iPhone",
    kind: "browser",
    platform: "iOS",
    tailscale: null,
    approvedAt: "2026-10-28T10:00:00Z",
    lastActiveAt: "2026-11-02T13:00:00Z",
    revokedAt: null,
    ...change,
  });

const status = (change: Partial<RemoteAccessStatus>): RemoteAccessStatus => ({
  enabled: false,
  paused: false,
  port: 4317,
  tailscale: { state: "running", dnsName: "studio-desk.example.ts.net", addresses: ["100.101.102.103"] },
  listening: [],
  problem: "off",
  detail: null,
  https: { enabled: false, port: 4318, listening: false, forwarding: null, detail: null },
  ...change,
});

describe("allowed devices", () => {
  it("names the hub's window by what it is and offers it as the hub", () => {
    const window = device({ id: WINDOW_DEVICE_ID, kind: "window", name: "window", platform: "" });
    expect(deviceName(window)).toBe("This computer's Hobbots window");
    expect(deviceMeta(window, now)).toBe("The hub · hobs work here");
  });

  it("says what a device uses, where it was approved from and when it was last active", () => {
    expect(deviceMeta(device({}), now)).toMatch(/^A browser · iOS · on this computer · active 2 hours ago$/);
    const remote = device({
      kind: "desktop",
      platform: "",
      tailscale: { nodeId: "n1", nodeName: "macbook-air.example.ts.net", owner: { _tag: "User", login: "you" } },
    });
    expect(deviceMeta(remote, now)).toBe("The Hobbots app · macbook-air · active 2 hours ago");
    expect(deviceMeta(device({ lastActiveAt: null }), now)).toMatch(
      /^A browser · iOS · on this computer · allowed .+, not used yet$/,
    );
  });

  // covers DP-001
  it("[TC-DP-215] on a connected desktop, names the hub, marks this Mac's own device and shows both versions", () => {
    const context = { hub: "Studio", ownDeviceId: "d1" };
    const window = device({ id: WINDOW_DEVICE_ID, kind: "window", name: "window", platform: "" });
    expect(deviceName(window, context)).toBe("The Hobbots window on Studio");
    expect(deviceMeta(device({ kind: "desktop", platform: "macOS" }), now, context)).toBe(
      "this Mac · The Hobbots app · macOS · on Studio · active 2 hours ago",
    );
    expect(deviceMeta(device({ id: DeviceId.make("d2") }), now, context)).toMatch(/^A browser · iOS · on Studio · /);

    const view = {
      hubName: "Studio",
      nodeName: "studio-desk.example.ts.net",
      address: "http://studio-desk.example.ts.net:4317",
      deviceId: "d1",
      appVersion: "0.5.1",
      hubVersion: "0.5.0",
      state: "connected",
    };
    expect(versionsLine(view)).toBe("Hobbots 0.5.0 on Studio · 0.5.1 on this Mac");
    expect(versionsLine({ ...view, hubVersion: null })).toBe("Hobbots 0.5.1 on this Mac");
  });

  // covers DP-001
  it("[TC-DP-219] offers Disconnect only where the desktop app's bridge has it, as ADR 025 asks of every call", () => {
    const get = async () => {
      throw new Error("not called");
    };
    const disconnect = async () => ({ stillListed: false });
    expect(connectionCalls({ get, disconnect })).toMatchObject({ get, disconnect });
    // The previous desktop app's bridge: the hub it uses, and no Disconnect.
    expect(connectionCalls({ get })).toEqual({
      get,
      disconnect: undefined,
      retry: undefined,
      changeAddress: undefined,
      openTailscale: undefined,
      onChange: undefined,
    });
    // No bridge, or one that cannot say which hub it uses: the hub's own settings show.
    expect(connectionCalls(undefined)).toBeUndefined();
    expect(connectionCalls({ disconnect })).toBeUndefined();
    // Its answer names no device, so no row is marked as this Mac's and every row keeps Revoke.
    expect(deviceMeta(device({}), now, { hub: "Studio" })).toMatch(/^A browser · iOS · on Studio · /);
  });

  it("lists only devices that were not revoked", () => {
    const revoked = device({ id: DeviceId.make("d2"), revokedAt: "2026-11-01T10:00:00Z" });
    expect(approvedDevices([device({}), revoked]).map((d) => d.id)).toEqual(["d1"]);
  });
});

describe("remote access settings", () => {
  it("takes only ports the hub may listen on", () => {
    expect(typedPort("4400")).toBe(4400);
    expect(typedPort("80")).toBeNull();
    expect(typedPort("70000")).toBeNull();
    expect(typedPort("")).toBeNull();
  });

  it("names the hub on its tailnet by its MagicDNS name, or else its address", () => {
    expect(tailnetName(status({}))).toBe("studio-desk");
    expect(tailnetName(status({ tailscale: { state: "running", dnsName: null, addresses: ["100.1.2.3"] } }))).toBe(
      "100.1.2.3",
    );
  });

  it("says when Tailscale is not ready while remote access is off", () => {
    expect(tailscaleNotReady(status({}))).toBeNull();
    expect(tailscaleNotReady(status({ tailscale: null }))).toBeNull();
    expect(tailscaleNotReady(status({ tailscale: { state: "signedOut", dnsName: null, addresses: [] } }))).toBe(
      "Tailscale is signed out on this computer. Sign in so your other devices can reach Hobbots.",
    );
  });

  it("draws the address as a square QR code with a quiet zone", () => {
    const rows = qrRows("http://studio-desk.example.ts.net:4317");
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.every((row) => row.length === rows.length)).toBe(true);
    expect(rows[0]).toMatch(/^\.+$/);
  });
});
