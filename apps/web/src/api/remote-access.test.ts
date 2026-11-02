import type { RemoteAccessStatus } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { serveAsk } from "../components/devices/https-settings.tsx";
import { remoteAccessWhy, remoteAddress } from "../components/remote-access-settings.tsx";
import { movedPage, securePage } from "./remote-access.ts";

const status = (change: Partial<RemoteAccessStatus>): RemoteAccessStatus => ({
  enabled: true,
  paused: false,
  port: 4317,
  tailscale: { state: "running", dnsName: "studio-desk.example.ts.net", addresses: ["100.101.102.103"] },
  listening: ["100.101.102.103"],
  problem: null,
  detail: null,
  https: { enabled: false, port: 4318, listening: false, forwarding: null, detail: null },
  ...change,
});

describe("movedPage", () => {
  it("moves a page the hub serves to the new port, keeping its host and route", () => {
    const page = new URL("http://studio-desk.example.ts.net:4317/#/settings");
    expect(movedPage(page, page.origin, 4400)).toBe("http://studio-desk.example.ts.net:4400/#/settings");
  });

  it("leaves a page on the same port, one without a port, or one served elsewhere", () => {
    const page = new URL("http://127.0.0.1:4317/");
    expect(movedPage(page, page.origin, 4317)).toBeNull();
    expect(
      movedPage(new URL("https://studio-desk.example.ts.net/"), "https://studio-desk.example.ts.net", 4400),
    ).toBeNull();
    expect(movedPage(new URL("http://localhost:5173/"), "http://127.0.0.1:4317", 4400)).toBeNull();
  });
});

describe("remote access in Settings", () => {
  it("says why the hub is not on the tailnet", () => {
    expect(remoteAccessWhy(status({}))).toBeNull();
    expect(remoteAccessWhy(status({ enabled: false, problem: "off" }))).toBeNull();
    const tailscale = (state: "notInstalled" | "notRunning" | "signedOut") =>
      remoteAccessWhy(
        status({ problem: "tailscale", listening: [], tailscale: { state, dnsName: null, addresses: [] } }),
      );
    expect(tailscale("notInstalled")).toMatch(/^Tailscale is not installed on this computer/);
    expect(tailscale("notRunning")).toMatch(/^Tailscale is off on this computer/);
    expect(tailscale("signedOut")).toMatch(/^Tailscale is signed out on this computer/);
    expect(remoteAccessWhy(status({ problem: "noAddress", listening: [] }))).toMatch(/no tailnet address/);
    expect(remoteAccessWhy(status({ paused: true, problem: "paused", listening: [] }))).toMatch(
      /^Remote access is paused from the menu-bar icon/,
    );
    expect(
      remoteAccessWhy(
        status({
          problem: "cannotListen",
          listening: [],
          detail: "100.101.102.103:4317: another program is using the port",
        }),
      ),
    ).toBe("Hobbots could not listen on your tailnet: 100.101.102.103:4317: another program is using the port.");
  });

  it("gives the address other devices type: the MagicDNS name, else the tailnet address, at the hub's port", () => {
    expect(remoteAddress(status({}))).toBe("http://studio-desk.example.ts.net:4317");
    expect(
      remoteAddress(
        status({
          tailscale: { state: "running", dnsName: null, addresses: ["fd7a:115c:a1e0::1"] },
          listening: ["fd7a:115c:a1e0::1"],
        }),
      ),
    ).toBe("http://[fd7a:115c:a1e0::1]:4317");
    expect(remoteAddress(status({ listening: [] }))).toBeNull();
  });
});

describe("HTTPS through tailscale serve in Settings", () => {
  const serving = { enabled: true, port: 4318, listening: true, forwarding: true, detail: null } as const;

  // covers DP-004
  it("[TC-DP-137] gives the HTTPS address only while Tailscale serves the hub there, and moves the page there", () => {
    expect(remoteAddress(status({ https: serving }))).toBe("https://studio-desk.example.ts.net");
    // On but not forwarded yet, or forwarded with HTTPS off: the HTTP address stays.
    expect(remoteAddress(status({ https: { ...serving, forwarding: false } }))).toBe(
      "http://studio-desk.example.ts.net:4317",
    );
    expect(remoteAddress(status({ https: { ...serving, enabled: false, listening: false } }))).toBe(
      "http://studio-desk.example.ts.net:4317",
    );
    // Not on the tailnet at all: no address.
    expect(remoteAddress(status({ https: serving, listening: [] }))).toBeNull();
  });

  // covers DP-004
  it("[TC-DP-138] asks to run tailscale serve while it does not match the switch, and to remove what is left over", () => {
    const off = { enabled: false, port: 4318, listening: false, forwarding: false, detail: null } as const;
    expect(serveAsk(status({ https: off }))).toBeNull();
    expect(serveAsk(status({ https: { ...serving, forwarding: false } }))).toBe("forward");
    expect(serveAsk(status({ https: serving }))).toBeNull();
    // The hub could not read serve: it asks nothing.
    expect(serveAsk(status({ https: { ...serving, forwarding: null } }))).toBeNull();
    // HTTPS or remote access off while serve still forwards: remove it.
    expect(serveAsk(status({ https: { ...off, forwarding: true } }))).toBe("remove");
    expect(serveAsk(status({ enabled: false, https: { ...serving, listening: false } }))).toBe("remove");
    // Paused: the listener is closed for now, and nothing is asked.
    expect(serveAsk(status({ paused: true, https: { ...serving, listening: false, forwarding: false } }))).toBeNull();

    // A page on the tailnet's HTTP address moves to the HTTPS one once Tailscale serves it.
    const page = new URL("http://studio-desk.example.ts.net:4317/#/settings");
    expect(securePage(page, page.origin, status({ https: serving }))).toBe(
      "https://studio-desk.example.ts.net/#/settings",
    );
    expect(securePage(page, page.origin, status({}))).toBeNull();
    const local = new URL("http://127.0.0.1:4317/#/settings");
    expect(securePage(local, local.origin, status({ https: serving }))).toBeNull();
    const secure = new URL("https://studio-desk.example.ts.net/#/settings");
    expect(securePage(secure, secure.origin, status({ https: serving }))).toBeNull();
  });
});
