import { type Agent, type AgentId, type Chapter, ThreadId, takesNewWork } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@hobbots/ui/components/dialog";
import { Input } from "@hobbots/ui/components/input";
import { Textarea } from "@hobbots/ui/components/textarea";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useId, useReducer } from "react";
import { useMoveChapter } from "../../api/camp-suggestions.ts";
import { useMakeCamp } from "../../api/camps.ts";
import { agentsQuery } from "../../api/queries.ts";
import { sidebarQuery } from "../../api/sidebar.ts";
import { HobPicker } from "../members/hob-picker.tsx";
import { messages as memberCopy } from "../members/messages.ts";
import { AlongRow, CampField } from "./camp-parts.tsx";
import {
  type CampDraft,
  campLead,
  campPayload,
  campProblems,
  type MakeCamp,
  type MakeCampEvent,
  makeCampError,
  makeCampStep,
  refusedHob,
  startMakeCamp,
  toggleHob,
} from "./make-camp-flow.ts";
import { messages } from "./messages.ts";

const copy = messages.make;

/**
 * A chat's chapter a camp is made from, which moves into it, and what it holds, in words: `title` names
 * the chapter. `name` and `goal` prefill the camp's, as a camp suggestion offers them (#1557).
 */
export interface CampFrom {
  readonly chapter: Chapter;
  readonly title: string;
  readonly detail: string;
  readonly name?: string;
  readonly goal?: string;
}

/**
 * Make a camp (ADR 037; Screens › GroupChatNew): its name, its goal, the hobs it is made with (ADR
 * 039, Members), the first of which leads its quests, whether it is private, and the chat's chapter
 * it is made from, which moves into it unless you switch it off. `hob` is picked first. The camp
 * opens once it is made; a failure keeps what you typed and says why. `held`: the chat's chapter
 * cannot move now, as while a reply runs there: the hub refuses the move until it ends, so Make the
 * camp waits for it, unless you switch the chapter off.
 */
export function MakeCampSheet({
  hob,
  from,
  held: chapterHeld = false,
  onClose,
}: {
  hob: Agent;
  from?: CampFrom | undefined;
  held?: boolean;
  onClose: () => void;
}) {
  const [state, dispatch] = useReducer(makeCampStep, undefined, () =>
    startMakeCamp(from?.name ?? "", from !== undefined, from?.goal ?? "", [hob.id]),
  );
  const make = useMakeCamp();
  // Every hob that takes new work can be picked; the one whose chapter moves in stays first.
  const hobs = (useQuery(agentsQuery).data ?? []).filter((each) => takesNewWork(each) || each.id === hob.id);
  const locked: AgentId | null = from !== undefined && state.draft.chapter ? hob.id : null;
  const move = useMoveChapter(from?.chapter.threadId ?? ("" as ThreadId));
  const navigate = useNavigate();
  const { draft } = state;
  const saving = state.step === "saving";
  // The chapter comes along but cannot move yet: Make the camp waits until it can.
  const held = !saving && from !== undefined && draft.chapter && chapterHeld;
  const problems = campProblems(draft);
  // A field's problem shows once it lost focus, or once a send found it.
  const problemOf = (field: keyof CampDraft) => {
    const problem = problems[field];
    return problem !== undefined && state.step === "editing" && state.shown.has(field)
      ? copy.problems[problem]
      : undefined;
  };
  const edit = (change: Partial<CampDraft>) => dispatch({ _tag: "Edit", draft: { ...draft, ...change } });

  const send = () => {
    // The reducer decides whether it saves and under which key; the request follows its answer.
    const event: MakeCampEvent = { _tag: "Send", key: ThreadId.make(crypto.randomUUID()), held };
    const next = makeCampStep(state, event);
    dispatch(event);
    if (next.step !== "saving") return;
    const lead = campLead(next.draft) ?? hob.id;
    const opened = {
      onSuccess: ({ id }: { readonly id: ThreadId }) => {
        onClose();
        void navigate({ to: "/hobs/$hobId/threads/$threadId", params: { hobId: lead, threadId: id } });
      },
      onError: (error: unknown) => dispatch({ _tag: "Failed", error: makeCampError(error), hob: refusedHob(error) }),
    };
    const payload = campPayload(next.draft, next.key);
    if (from !== undefined && next.draft.chapter) {
      move.mutate(
        { chapterId: from.chapter.id, into: { _tag: "new", ...payload } },
        { ...opened, onSuccess: (moved) => opened.onSuccess(moved.camp) },
      );
    } else make.mutate({ agentId: lead, payload }, opened);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent variant="sheet" className="max-w-bubble-max">
        <DialogTitle variant="heading">{copy.title}</DialogTitle>
        <DialogDescription variant="lead">{copy.lead}</DialogDescription>
        <form
          noValidate
          className="flex flex-col gap-3.5"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <fieldset disabled={saving} className="m-0 flex flex-col gap-3.5 border-0 p-0">
            <CampField label={copy.name} problem={problemOf("title")}>
              {({ id, noteId }) => (
                <Input
                  id={id}
                  value={draft.title}
                  autoComplete="off"
                  placeholder={copy.namePlaceholder}
                  aria-invalid={problemOf("title") !== undefined}
                  aria-describedby={noteId}
                  onBlur={() => dispatch({ _tag: "Leave", field: "title" })}
                  onChange={(event) => edit({ title: event.target.value })}
                />
              )}
            </CampField>
            <CampField label={copy.goal} problem={problemOf("goal")}>
              {({ id, noteId }) => (
                <Textarea
                  id={id}
                  rows={2}
                  value={draft.goal}
                  placeholder={copy.goalPlaceholder}
                  aria-invalid={problemOf("goal") !== undefined}
                  aria-describedby={noteId}
                  onBlur={() => dispatch({ _tag: "Leave", field: "goal" })}
                  onChange={(event) => edit({ goal: event.target.value })}
                />
              )}
            </CampField>
            <MembersField
              hobs={hobs}
              picked={draft.hobs}
              locked={locked}
              problem={problemOf("hobs")}
              onToggle={(id) => edit({ hobs: toggleHob(draft.hobs, id, locked) })}
            />
            {from !== undefined && (
              <>
                <AlongRow
                  title={copy.chapter({ title: from.title })}
                  detail={copy.chapterDetail({ from: from.detail })}
                  checked={draft.chapter}
                  onChange={(value) => edit({ chapter: value })}
                />
                <p className="m-0 text-meta text-label">{copy.chapterLink}</p>
              </>
            )}
            <AlongRow
              title={copy.private}
              detail={copy.privateDetail}
              checked={draft.private}
              onChange={(value) => edit({ private: value })}
            />
          </fieldset>
          {held ? (
            <p role="status" className="m-0 text-ui text-text-secondary">
              {copy.held({ name: hob.name })}
            </p>
          ) : (
            state.step === "failed" && (
              <p role="alert" className="m-0 text-ui text-rose">
                {copy.errors[state.error]({ name: failedName(hobs, state, hob) })}
              </p>
            )
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              {copy.cancel}
            </Button>
            <Button type="submit" disabled={saving || held}>
              {saving ? copy.making : copy.make}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The hob a failure names: the one the hub turned away, else the one that leads, else `hob`. */
const failedName = (hobs: ReadonlyArray<Agent>, state: MakeCamp & { step: "failed" }, hob: Agent) =>
  hobs.find((each) => each.id === state.hob)?.name ??
  hobs.find((each) => each.id === campLead(state.draft))?.name ??
  hob.name;

/** The hobs the camp is made with (ADR 039, Members), picked in order, with why the first leads. */
function MembersField({
  hobs,
  picked,
  locked,
  problem,
  onToggle,
}: {
  hobs: ReadonlyArray<Agent>;
  picked: ReadonlyArray<AgentId>;
  locked: AgentId | null;
  problem: string | undefined;
  onToggle: (id: AgentId) => void;
}) {
  const you = useQuery(sidebarQuery).data?.you;
  const membersId = useId();
  const noteId = `${membersId}-note`;
  return (
    <div className="flex flex-col gap-1.5">
      <span id={membersId} className="lbl text-meta text-label">
        {memberCopy.picker.label}
      </span>
      <HobPicker
        you={you}
        hobs={hobs}
        picked={picked}
        locked={locked}
        labelledBy={membersId}
        describedBy={noteId}
        onToggle={onToggle}
      />
      {problem !== undefined ? (
        <span id={noteId} role="alert" className="text-meta text-rose">
          {problem}
        </span>
      ) : (
        <span id={noteId} className="text-meta text-label">
          {memberCopy.picker.note}
        </span>
      )}
    </div>
  );
}
