import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { logProcessFailures } from "../src/main/process-failures.ts";

describe("failures outside any handler", () => {
  it("logs an uncaught exception and an unhandled rejection", () => {
    const process = new EventEmitter();
    const logged: unknown[] = [];
    logProcessFailures(process as unknown as Parameters<typeof logProcessFailures>[0], (_message, error) =>
      logged.push(error),
    );
    const error = new Error("boom");
    process.emit("uncaughtException", error);
    process.emit("unhandledRejection", "lost");
    expect(logged).toEqual([error, "lost"]);
  });
});
