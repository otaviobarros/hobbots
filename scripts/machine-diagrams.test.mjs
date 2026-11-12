import assert from "node:assert/strict";
import { test } from "node:test";
import { diagramProblems, kebab, render } from "./machine-diagrams.mjs";

const entry = {
  exportName: "TaskMachine",
  module: "packages/domain/src/task.ts",
  machine: {
    name: "TaskRun",
    field: "state",
    states: ["queued", "active", "done"],
    meanings: { queued: "Waiting", active: "Running", done: "Ended" },
    table: [
      { event: "Start", from: ["queued"], to: "active", guarded: false },
      { event: "End", from: ["active"], to: "done", guarded: true },
    ],
  },
};
const file = `${kebab(entry.machine.name)}.md`;
const pages = new Map([[file, render(entry)]]);

// covers ADR 037 (Validation), #1360
test("[TC-GEN-1360-01] an out-of-date, missing or orphaned machine diagram fails the check", () => {
  assert.equal(file, "task-run.md");
  assert.deepEqual(
    diagramProblems(pages, [file], () => render(entry)),
    [],
  );
  const older = render({ ...entry, machine: { ...entry.machine, table: entry.machine.table.slice(0, 1) } });
  assert.deepEqual(
    diagramProblems(pages, [file], () => older),
    ["docs/architecture/machines/task-run.md is out of date"],
  );
  assert.deepEqual(
    diagramProblems(pages, [], () => ""),
    ["docs/architecture/machines/task-run.md is missing"],
  );
  assert.deepEqual(
    diagramProblems(pages, [file, "gone.md"], () => render(entry)),
    ["docs/architecture/machines/gone.md names no machine"],
  );
});

test("a diagram draws each row of the table and ends at the states nothing leaves", () => {
  const page = render(entry);
  assert.match(page, / {2}queued --> active: Start\n/);
  assert.match(page, / {2}active --> done: End \(guarded\)\n/);
  assert.match(page, / {2}done --> \[\*\]\n/);
});
