import { Effect } from "effect";
import { makeMemoryStoreFake } from "../src/store/fake.ts";
import { captureContract } from "./capture-contract.ts";

captureContract("the fake", () =>
  Effect.sync(() => {
    const { store, controls } = makeMemoryStoreFake();
    return {
      store,
      observations: (agentId, sessionId) =>
        Effect.sync(() => controls.captured({ _tag: "Hob", agentId }, sessionId).length),
      down: Effect.sync(() => controls.setDown(true)),
      up: Effect.sync(() => controls.setDown(false)),
    };
  }),
);
