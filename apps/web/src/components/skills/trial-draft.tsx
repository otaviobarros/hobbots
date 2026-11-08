import type { SkillTrialText } from "@hobbots/api";
import { ThreadId } from "@hobbots/domain";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { skillTrialDraftQuery } from "../../api/skill-trials.ts";
import { messages } from "./messages.ts";

const copy = messages.trial;

function DraftRead({ trial, children }: { trial: string; children: (draft: SkillTrialText | null) => ReactNode }) {
  const draft = useQuery(skillTrialDraftQuery(ThreadId.make(trial)));
  if (draft.isError) {
    return (
      <>
        <p role="alert" className="m-0 max-w-[760px] text-ui text-text-secondary">
          {copy.editorGone}
        </p>
        {children(null)}
      </>
    );
  }
  if (draft.data === undefined) {
    return (
      <div role="status" aria-busy="true" aria-label={copy.loadingDraft} className="flex max-w-[760px] flex-col gap-3">
        <Skeleton width="40%" />
        <Skeleton width="80%" />
      </div>
    );
  }
  return children(draft.data);
}

/**
 * An editor opened from a chat that tried its draft (ADR 029, Try in a chat, #1099): it opens on the
 * text you tried, read back from the hub, so trying a draft never loses it. Without `trial`, or once
 * the hub no longer has the draft, the editor opens as it would.
 */
export function TrialDraft({
  trial,
  children,
}: {
  trial: string | null;
  children: (draft: SkillTrialText | null) => ReactNode;
}) {
  return trial === null ? children(null) : <DraftRead trial={trial}>{children}</DraftRead>;
}
