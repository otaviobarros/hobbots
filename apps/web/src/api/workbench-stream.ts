import { CommandOutput, STREAM_FRAME, StreamReady, type TaskId } from "@hobbots/domain";
import { useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { useEffect, useState } from "react";
import { API_URL } from "./client.ts";
import { applyCommandOutput, treeChanged } from "./workbench.ts";

const decodeReady = Schema.decodeUnknownSync(Schema.fromJsonString(StreamReady));
const decodeCommandOutput = Schema.decodeUnknownSync(Schema.fromJsonString(CommandOutput));

/** How long a stream the hub closed waits before it opens again. */
const REOPEN_AFTER_MS = 2000;

/** Where a tree's Workbench stream is, resumed after `cursor` when there is one. */
const workbenchStreamUrl = (taskId: TaskId, cursor: string | undefined): string => {
  const after = cursor === undefined ? "" : `?after=${encodeURIComponent(cursor)}`;
  return `${API_URL}/api/tasks/${encodeURIComponent(taskId)}/workbench/events${after}`;
};

/**
 * Keeps a Quest's Workbench live through its one stream (#899): `GET
 * /api/tasks/:taskId/workbench/events`, opened from `cursor`, the one its read was taken at. Every
 * journal entry it sends changes what the tree's read returns, so each reads the tree again; a
 * running command's output is kept as it comes. The browser resumes a dropped stream from the last
 * entry it saw, including those the hub passed over; a fresh `Ready` that could not resume reads the
 * tree again, as a refused stream does once it opens again.
 */
export const useWorkbenchStream = (taskId: TaskId, cursor: string | undefined) => {
  const queryClient = useQueryClient();
  const [opened, setOpened] = useState<{ readonly taskId: TaskId; readonly cursor: string } | null>(null);
  const [reopened, setReopened] = useState(0);
  // The stream opens once per tree, from its first read; later reads leave it where it is.
  if (cursor !== undefined && opened?.taskId !== taskId) setOpened({ taskId, cursor });
  const from = opened?.taskId === taskId ? opened.cursor : undefined;

  // biome-ignore lint/correctness/useExhaustiveDependencies: a reopen opens a new stream.
  useEffect(() => {
    if (from === undefined) return;
    let last = from;
    const source = new EventSource(workbenchStreamUrl(taskId, last));
    const changed = () => void treeChanged(queryClient, taskId);
    source.addEventListener(STREAM_FRAME.ready, (frame) => {
      try {
        if (!decodeReady(frame.data).resumed) changed();
      } catch (error) {
        console.warn("Ignoring malformed event", error);
      }
    });
    source.onmessage = (frame) => {
      last = frame.lastEventId;
      changed();
    };
    source.addEventListener(STREAM_FRAME.commandOutput, (frame) => {
      try {
        applyCommandOutput(queryClient, decodeCommandOutput(frame.data));
      } catch (error) {
        console.warn("Ignoring malformed event", error);
      }
    });
    let reopen: ReturnType<typeof setTimeout> | undefined;
    source.onerror = () => {
      if (source.readyState !== EventSource.CLOSED || reopen !== undefined) return;
      reopen = setTimeout(() => {
        setOpened({ taskId, cursor: last });
        setReopened((count) => count + 1);
      }, REOPEN_AFTER_MS);
    };
    return () => {
      clearTimeout(reopen);
      source.close();
    };
  }, [queryClient, taskId, from, reopened]);
};
