import { AgentId, Task, TaskId, type TaskState } from "@hobbots/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { useTaskControl } from "../../api/task-controls.ts";
import { PauseControls } from "./pause-controls.tsx";

// Issue #1446: the quest's sheet pauses and resumes the work; Pause now is in its ⋯ menu.

const at = "2026-11-13T10:00:00.000Z";

const top = (state: TaskState) =>
  new Task({
    id: TaskId.make("top"),
    ownerId: AgentId.make("aldric"),
    parentId: null,
    rootId: TaskId.make("top"),
    threadId: null,
    brief: "Launch page",
    state,
    dependsOn: [],
    result: null,
    currentAttemptId: null,
    createdAt: at,
    updatedAt: at,
    revision: 1,
    pause:
      state === "paused" || state === "pausing"
        ? { from: "waiting", at, by: { kind: "user", id: "owner" }, now: false }
        : null,
  });

const idle = { isError: false, isPending: false, error: null, mutate: () => {} } as unknown as ReturnType<
  typeof useTaskControl
>;

const render = (state: TaskState) =>
  renderToStaticMarkup(<PauseControls top={top(state)} quest={null} owner="Aldric" control={idle} />);

const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("the quest's Pause and Resume", () => {
  it("[TC-OR-1446-09] offers a quiet Pause while the work runs, and a Paused banner with Resume once it is paused", () => {
    const running = render("waiting");
    expect(textOf(running)).toBe("Pause");
    expect(running).toContain('data-variant="quiet"');
    const paused = render("paused");
    expect(paused).toContain('aria-label="Paused"');
    expect(textOf(paused)).toContain("No turn starts on this quest until you resume it.");
    expect(textOf(paused)).toContain("Resume");
    expect(textOf(render("pausing"))).toContain("The turn running now finishes first.");
    // A finished quest has nothing to pause.
    expect(render("completed")).toBe("");
  });
});
