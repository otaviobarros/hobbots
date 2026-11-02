import { Device, DeviceId, type RemoteAccessStatus, WINDOW_DEVICE_ID } from "@hobbots/domain";
import { qrRows } from "@hobbots/ui/components/qr-code";
import { describe, expect, it } from "vitest";
import { approvedDevices } from "../../api/devices.ts";
import { tailnetName, tailscaleNotReady } from "../remote-access-settings.tsx";
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
