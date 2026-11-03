import type { AddressRefusal, ConnectEnd, PairingEnd } from "@hobbots/api";
import { describe, expect, it } from "vitest";
import { endedSpeech, endedText, refusalText } from "./connect-model.ts";

const ended = (outcome: PairingEnd): Extract<ConnectEnd, { kind: "ended" }> => ({
  kind: "ended",
  computer: "studio",
  address: "http://studio.example.ts.net:4317",
  outcome,
});

describe("Connect's words", () => {
  it("says why each request that did not connect ended, naming the computer or the address", () => {
    expect(endedText(ended({ kind: "denied" }))).toEqual({
      title: "studio said no",
      body: "This computer wasn't allowed. If that was a mistake, ask again and choose Allow on studio.",
    });
    expect(endedText(ended({ kind: "throttled", retryAfterSeconds: 1 })).body).toMatch(/^Wait 1 second before/);
    expect(endedText(ended({ kind: "unsupported", side: "hubOlder", version: "0.4.0" })).title).toBe(
      "studio runs an older Hobbots (0.4.0)",
    );
    expect(endedText(ended({ kind: "unsupported", side: "appOlder", version: "0.9.0" })).body).toBe(
      "Update Hobbots on this computer to connect.",
    );
    expect(endedText(ended({ kind: "notHobbots" })).title).toBe(
      "Something other than Hobbots answers at http://studio.example.ts.net:4317",
    );
    expect(endedText(ended({ kind: "refused", reason: "full" })).title).toBe("studio has too many requests waiting");
    expect(endedText(ended({ kind: "noKeychain", message: "locked" })).body).toContain("(locked)");
    // Every way it can end has its own words.
    const outcomes: ReadonlyArray<PairingEnd> = [
      { kind: "denied" },
      { kind: "expired" },
      { kind: "notYourNode" },
      { kind: "notHobbots" },
      { kind: "noAnswer" },
      { kind: "unsupported", side: "hubOlder", version: "0.4.0" },
      { kind: "unsupported", side: "appOlder", version: "0.9.0" },
      { kind: "refused", reason: "notYours" },
      { kind: "refused", reason: "name" },
      { kind: "throttled", retryAfterSeconds: 42 },
      { kind: "otherNode" },
      { kind: "noKeychain", message: "locked" },
    ];
    const titles = outcomes.map((outcome) => endedText(ended(outcome)).title);
    expect(new Set(titles).size).toBe(titles.length - 1); // notYourNode and the hub's notYours read the same
    expect(endedSpeech(ended({ kind: "denied" }))).toContain("studio");
  });

  it("says why a typed address was refused before anything was sent", () => {
    const refusals: ReadonlyArray<AddressRefusal> = [
      { reason: "Empty" },
      { reason: "Malformed" },
      { reason: "Loopback" },
      { reason: "LocalNetwork" },
      { reason: "Public" },
      { reason: "NotOnTailnet" },
      { reason: "ThisComputer" },
      { reason: "TailscaleNotReady", state: "notInstalled" },
      { reason: "TailscaleNotReady", state: "notRunning" },
      { reason: "TailscaleNotReady", state: "signedOut" },
      { reason: "NotYours", computer: "shared" },
    ];
    const texts = refusals.map(refusalText);
    expect(new Set(texts).size).toBe(texts.length);
    expect(refusalText({ reason: "NotYours", computer: "shared" })).toMatch(/^shared isn't one of your own computers/);
  });
});
