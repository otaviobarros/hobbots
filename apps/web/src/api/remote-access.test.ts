import type { RemoteAccessStatus } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { remoteAccessWhy, remoteAddress } from "../components/remote-access-settings.tsx";
import { movedPage } from "./remote-access.ts";

const status = (change: Partial<RemoteAccessStatus>): RemoteAccessStatus => ({
  enabled: true,
  port: 4317,
  tailscale: { state: "running", dnsName: "studio-desk.example.ts.net", addresses: ["100.101.102.103"] },
  listening: ["100.101.102.103"],
  problem: null,
  detail: null,
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
