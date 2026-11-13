import { messages } from "./messages.ts";

/** A Charm's name as the app shows it, such as GitHub. */
export const charmName = (charm: string): string =>
  charm === "github" ? messages.charms.github.name : charm.charAt(0).toUpperCase() + charm.slice(1);
