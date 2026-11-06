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
      // The fake keeps what it was sent: the time an item carries, and its first line as its title.
      observed: (agentId, sessionId) =>
        Effect.sync(() =>
          controls
            .captured({ _tag: "Hob", agentId }, sessionId)
            .map((item) => ({ title: item.text.split("\n", 1)[0] ?? "", at: item.at ?? "" })),
        ),
      down: Effect.sync(() => controls.setDown(true)),
      up: Effect.sync(() => controls.setDown(false)),
    };
  }),
);
