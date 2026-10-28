import { Schema } from "effect";

/** The fixed set of hob colors from the Hobbots design (docs/design/ui-ux.md). */
export const HobColor = Schema.Literals(["violet", "moss", "amber", "rose", "sky", "ember"]);
export type HobColor = typeof HobColor.Type;

/** Seeds the avatar generator; the same seed always draws the same hob. */
export const LookSeed = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 ** 32 - 1 }));
