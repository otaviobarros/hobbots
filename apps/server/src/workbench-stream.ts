import { TaskRepository } from "@hobbots/agents";
import { type HobbotsEvent, TaskId } from "@hobbots/domain";
import { Effect, Option, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { forApprovedDevice } from "./devices.ts";
import type { HubTransientEvent } from "./event-bus.ts";
import { EventStream, encodeFrame, resumeCursor, type StreamFrame, sseResponse } from "./event-stream.ts";

/** The Task of an event that changes what a tree's Workbench read returns, or null for any other event. */
const workbenchTask = (event: HobbotsEvent | HubTransientEvent): TaskId | null => {
  switch (event._tag) {
    case "CommandRecorded":
      return event.command.taskId;
    case "FileChangesRecorded":
    case "AttemptStepsRecorded":
    case "CommandOutput":
      return event.taskId;
    case "FolderScanned":
      return event.scan.taskId;
    // A new Task, an Attempt that starts or ends, a reassignment that changes an Attempt's owner, and a
    // completion that adds its artifacts: each changes what the tree's read returns.
    case "TaskCreated":
    case "TaskStateChanged":
    case "TaskCompleted":
      return event.task.id;
    default:
      return null;
  }
};

/** A frame of a tree's Workbench stream: a frame of the event stream, or an entry passed over. */
export type TreeFrame = StreamFrame | { readonly _tag: "Passed"; readonly cursor: string };

/**
 * Narrows a connection's frames to one Task tree's Workbench (#899): `Ready` and keep-alives, the
 * journal entries that change what the tree's read returns, and the output of every command running
 * in the tree; null drops a transient event outside it. `tree` holds the tree's Tasks, and grows as
 * Tasks are created under them. Every other entry becomes `Passed`, which moves the client's cursor
 * past it without an event, so a client that reconnects resumes after it rather than replaying it.
 */
export const treeFrame = (frame: StreamFrame, tree: Set<TaskId>): TreeFrame | null => {
  if (frame._tag === "Transient") {
    const taskId = workbenchTask(frame.event);
    return taskId !== null && tree.has(taskId) ? frame : null;
  }
  if (frame._tag !== "Entry") return frame;
  const payload = frame.entry.payload;
  if (payload._tag === "TaskCreated" && payload.task.parentId !== null && tree.has(payload.task.parentId)) {
    tree.add(payload.task.id);
  }
  const taskId = workbenchTask(payload);
  return taskId !== null && tree.has(taskId) ? frame : { _tag: "Passed", cursor: frame.cursor };
};

/** Writes one frame in the SSE wire format: a passed entry is an `id` alone, which dispatches no event. */
export const encodeTreeFrame = (frame: TreeFrame): string =>
  frame._tag === "Passed" ? `id: ${frame.cursor}\n\n` : encodeFrame(frame);

/**
 * `GET /api/tasks/:taskId/workbench/events`: one live stream for a Quest's whole Workbench (#899),
 * the event stream of `GET /api/events` narrowed to the Task's tree. It resumes as that stream does,
 * from `Last-Event-ID` or `?after=<cursor>`, such as the cursor of `GET /api/tasks/:taskId/workbench`.
 * Only an approved device connects, and a Task that is not there is a 404, as its read is.
 */
export const WorkbenchStreamRoute = HttpRouter.add(
  "GET",
  "/api/tasks/:taskId/workbench/events",
  forApprovedDevice((request, device) =>
    Effect.gen(function* () {
      const events = yield* EventStream;
      const tasks = yield* TaskRepository;
      const taskId = TaskId.make((yield* HttpRouter.params).taskId ?? "");
      const tasksOf = Effect.map(
        tasks.readTree(taskId),
        Option.map((tree) => tree.tasks.map((task) => task.id)),
      );
      const first = yield* tasksOf;
      if (Option.isNone(first)) {
        return HttpServerResponse.text("No Task has this id.", {
          status: 404,
          headers: { "Cache-Control": "no-store" },
        });
      }
      const tree = new Set(first.value);
      // `Ready` comes once the stream's head is taken: the tree read again then holds every Task
      // created before it, and each one created after comes as a `TaskCreated` entry.
      const widen = Effect.map(tasksOf, (ids) => {
        for (const id of Option.getOrElse(ids, () => [])) tree.add(id);
      });
      const frames = events.connect(resumeCursor(request), device.id).pipe(
        Stream.mapEffect(
          (frame): Effect.Effect<StreamFrame> =>
            frame._tag === "Ready" ? Effect.as(widen, frame) : Effect.succeed(frame),
        ),
        Stream.map((frame) => treeFrame(frame, tree)),
        Stream.filter((frame): frame is TreeFrame => frame !== null),
        Stream.map(encodeTreeFrame),
      );
      return sseResponse(frames);
    }),
  ),
);
