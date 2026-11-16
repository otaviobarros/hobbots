import type { Actor, Agent, User } from "@hobbots/domain";
import type { Face } from "../sidebar/sidebar-rows.ts";
import { messages as copy } from "./messages.ts";

/** Who wrote a message in a thread, as the thread shows them: a name, and a face when this client knows them. */
export interface Who {
  readonly name: string;
  readonly face: Face | null;
}

/** The hobs and people a thread names its authors from. */
export interface Cast {
  readonly hobs: ReadonlyArray<Agent>;
  readonly you: User | undefined;
  readonly people: ReadonlyArray<User>;
}

/**
 * Who `actor` is: a hob by its name and tile, you as You, another person by their name and initials.
 * Someone this client does not know yet shows with no face and no name, rather than an id.
 */
export const whoIs = (cast: Cast, actor: Actor | null): Who => {
  if (actor?.kind === "hob") {
    const hob = cast.hobs.find((each) => each.id === actor.id);
    return { name: hob?.name ?? "", face: hob === undefined ? null : { _tag: "hob", hob } };
  }
  if (actor === null || actor.kind !== "user") return { name: "", face: null };
  const person = actor.id === cast.you?.id ? cast.you : cast.people.find((each) => each.id === actor.id);
  return {
    name: actor.id === cast.you?.id ? copy.you : (person?.name ?? ""),
    face: person === undefined ? null : { _tag: "person", person },
  };
};
