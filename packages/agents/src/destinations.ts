import type { InvalidFolder } from "@hobbots/api";
import { Context, type Effect } from "effect";

/**
 * Where the hub may write what you save from it, such as an export or a backup (ADR 026): a folder
 * on the hub, never inside a folder a hob works in, since a hob could read it there.
 */
export class SaveDestinations extends Context.Service<
  SaveDestinations,
  {
    /** The folder `typed` names, canonical; refused when it is not a folder on the hub or is inside a hob's folder. */
    readonly check: (typed: string) => Effect.Effect<string, InvalidFolder>;
  }
>()("@hobbots/agents/SaveDestinations") {}
