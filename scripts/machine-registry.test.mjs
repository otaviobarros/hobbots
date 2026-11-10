import assert from "node:assert/strict";
import { test } from "node:test";
import { declarationsIn } from "./machine-registry.mjs";

test("finds an exported machine and one that is not exported", () => {
  const text = [
    "export const TaskMachine = defineMachine<TaskState, TaskEvent, Task, Err>({",
    "const RunMachine: Machine<A, B, C, D> = defineMachine({",
    "const notAMachine = define({",
  ].join("\n");
  assert.deepEqual(declarationsIn(text), [
    { exportName: "TaskMachine", exported: true, typed: true },
    { exportName: "RunMachine", exported: false, typed: false },
  ]);
});
