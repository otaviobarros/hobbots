import { HubPort } from "@hobbots/domain";
import { Schema } from "effect";

const isHubPort = Schema.is(HubPort);

/**
 * Where the main process reaches the hub on this computer. The port can change while the app runs,
 * when the user moves the hub to another one in Settings (ADR 021), so every reader asks here each
 * time instead of keeping its own copy.
 */
export interface HubAddress {
  readonly port: number;
  /** The hub's loopback address, such as `http://127.0.0.1:4317`. */
  readonly apiUrl: string;
  /** Points every reader at `port`, one the hub accepts (1024 to 65535); answers whether it changed. */
  readonly move: (port: number) => boolean;
}

export const hubAddress = (port: number): HubAddress => {
  let current = port;
  return {
    get port() {
      return current;
    },
    get apiUrl() {
      return `http://127.0.0.1:${current}`;
    },
    move: (next) => {
      if (!isHubPort(next) || next === current) return false;
      current = next;
      return true;
    },
  };
};
