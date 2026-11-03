import { describe, expect, it } from "vitest";
import { reasonOf } from "./connected-desktop.ts";

const base = {
  hubName: "Studio",
  nodeName: "studio.example.ts.net",
  address: "http://studio.example.ts.net:4317",
  appVersion: "0.5.0",
  hubVersion: "0.5.0",
};

describe("the connected desktop's reason", () => {
  // covers DP-001
  it("[TC-DP-169] reads the app's reason, and keeps the generic banner for an app from before the reasons", () => {
    expect(
      reasonOf({
        ...base,
        state: "unreachable",
        title: "Hobbots on studio isn't answering.",
        detail: "It may be closed.",
        actions: ["tryAgain", "changeAddress", "somethingNewer"],
      }),
    ).toEqual({
      title: "Hobbots on studio isn't answering.",
      detail: "It may be closed.",
      address: base.address,
      actions: ["tryAgain", "changeAddress"],
    });
    // The bridge of an app from before the reasons sends only the state: no reason, so no crash.
    expect(reasonOf({ ...base, state: "unreachable" })).toBeNull();
    expect(reasonOf({ ...base, state: "unreachable", title: "Out of reach", actions: "tryAgain" })).toMatchObject({
      detail: "",
      actions: [],
    });
    expect(reasonOf({ ...base, state: "connected", title: "Connected to studio" })).toBeNull();
    expect(reasonOf({ ...base, state: "connecting", title: "Connecting to studio…" })).toBeNull();
    expect(reasonOf(null)).toBeNull();
    expect(reasonOf("unreachable")).toBeNull();
  });
});
