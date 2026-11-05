import { Schema } from "effect";
import { useState } from "react";
import { readStored, writeStored } from "../../lib/storage.ts";

const KEY = "room.technical";

/** The choice this device remembers, versioned so a later shape can tell it apart (STD-REACT-026). */
const StoredTechnical = Schema.Struct({ v: Schema.Literal(1), on: Schema.Boolean });

const parseTechnical = (stored: unknown): boolean => (Schema.is(StoredTechnical)(stored) ? stored.on : false);

/**
 * Whether the room's lanes show the technical steps: the exact commands, the files read and every
 * refusal, in place of everyday words. Off at first; the device remembers the choice.
 */
export const useTechnicalSteps = () => {
  const [on, setOn] = useState(() => parseTechnical(readStored<unknown>(KEY, null)));
  return {
    on,
    toggle: () => {
      writeStored(KEY, { v: 1, on: !on });
      setOn(!on);
    },
  };
};
