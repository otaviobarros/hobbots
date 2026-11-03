import type { AddressRefusal, ConnectEnd, HubListView, WaitingView } from "@hobbots/api";
import { messages } from "./messages.ts";

/** The bridge the desktop app's preload offers setup's local pages, and nothing else. */
export interface SetupBridge {
  /** Makes this computer the hub; the hub's own window takes over once it has started. */
  readonly runHere: () => Promise<void>;
  readonly findHubs: () => Promise<HubListView>;
  /** Connects to the address typed or picked; resolves once it is allowed, refused or over. */
  readonly connect: (address: string) => Promise<ConnectEnd>;
  readonly cancel: () => Promise<void>;
  /** Calls `listener` once the hub has a prompt with the matching code; answers a function that stops it. */
  readonly onWaiting: (listener: (waiting: WaitingView) => void) => () => void;
}

const copy = messages;

/** Why a typed address was refused, in Connect's words. */
export const refusalText = (refusal: AddressRefusal): string => {
  switch (refusal.reason) {
    case "TailscaleNotReady":
      return copy.refused.TailscaleNotReady[refusal.state];
    case "NotYours":
      return copy.refused.NotYours({ computer: refusal.computer });
    default:
      return copy.refused[refusal.reason];
  }
};

/** A refusal from the hub when it opened the request, by its reason. */
const hubRefusal = (reason: string, computer: string) => {
  if (reason === "full")
    return { title: copy.ended.full.title({ computer }), body: copy.ended.full.body({ computer }) };
  if (reason === "notYours") return { title: copy.ended.notYours.title, body: copy.ended.notYours.body({ computer }) };
  return { title: copy.ended.refused.title({ computer }), body: copy.ended.refused.body };
};

/** How a request that did not connect ended, as the ended screen's title and body. */
export const endedText = ({
  computer,
  address,
  outcome,
}: Extract<ConnectEnd, { kind: "ended" }>): { readonly title: string; readonly body: string } => {
  const ended = copy.ended;
  switch (outcome.kind) {
    case "denied":
      return { title: ended.denied.title({ computer }), body: ended.denied.body({ computer }) };
    case "expired":
      return ended.expired;
    case "throttled":
      return {
        title: ended.throttled.title,
        body: ended.throttled.body({ count: outcome.retryAfterSeconds, computer }),
      };
    case "refused":
      return hubRefusal(outcome.reason, computer);
    case "notYourNode":
      return { title: ended.notYours.title, body: copy.refused.NotYours({ computer }) };
    case "notHobbots":
      return { title: ended.notHobbots.title({ address }), body: ended.notHobbots.body };
    case "noAnswer":
      return { title: ended.noAnswer.title({ computer }), body: ended.noAnswer.body({ computer }) };
    case "unsupported":
      return outcome.side === "hubOlder"
        ? {
            title: ended.hubOlder.title({ computer, version: outcome.version }),
            body: ended.hubOlder.body({ computer }),
          }
        : { title: ended.appOlder.title({ computer }), body: ended.appOlder.body };
    case "otherNode":
      return { title: ended.otherNode.title({ address }), body: ended.otherNode.body };
    case "noKeychain":
      return { title: ended.noKeychain.title, body: ended.noKeychain.body({ reason: outcome.message }) };
  }
};

/** The Elder Hob's line for how a request ended. */
export const endedSpeech = (end: Extract<ConnectEnd, { kind: "ended" }>) =>
  end.outcome.kind === "denied" ? copy.elder.denied({ computer: end.computer }) : copy.elder.ended;

/** The setup bridge, only in the desktop app's setup window: the hub's pages never get it. */
export const setupBridge = (): SetupBridge | undefined =>
  (globalThis as { readonly hobbots?: { readonly setup?: SetupBridge } }).hobbots?.setup;
