import type { MemoryPageRead } from "@hobbots/api";
import { type MemoryKind, type MemoryScope, type MemoryVersion, memoryKindOf } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Input } from "@hobbots/ui/components/input";
import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import { Textarea } from "@hobbots/ui/components/textarea";
import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { memoryNotAnswering, memoryPageChanged, memoryVersionNow } from "../../api/memory-pages.ts";
import type { Say } from "./memory-actions.tsx";
import {
  draftOf,
  type EditorDraft,
  type EditorErrors,
  editorErrors,
  editorValid,
  localDay,
  newDraft,
  readersOf,
  saveOf,
  WRITABLE_KINDS,
} from "./memory-edit-model.ts";
import { EditorSettings } from "./memory-editor-settings.tsx";
import { authorName, type HobDirectory, type MemoryView, memorySearchOf, scopeName } from "./memory-model.ts";
import { KindTag } from "./memory-parts.tsx";
import { messages } from "./messages.ts";
import type { MemoryWrites } from "./use-memory-writes.ts";

const copy = messages;

/** Why the last Save wrote nothing: the page changed meanwhile, or the save failed. */
type Refusal =
  | { readonly _tag: "Changed"; readonly current: MemoryVersion | null }
  | { readonly _tag: "Failed"; readonly message: string };

const ALL_FIELDS: ReadonlySet<keyof EditorErrors> = new Set(["title", "body", "forgetOn"]);

/** The kind a new page starts as: the one the list showed, or a rule About you and a how-to elsewhere. */
const startingKind = (scope: MemoryScope, kind: MemoryKind | null): MemoryKind =>
  kind !== null && WRITABLE_KINDS.some((each) => each === kind) ? kind : scope._tag === "Everyone" ? "rule" : "howto";

/**
 * The editor (#959), for a page or a new one. Save writes the whole page as a new version by you over
 * the version it opened, so when a hob saved the page meanwhile nothing is written: your text stays,
 * and you choose to save it over theirs or to read theirs. About you uses the same editor.
 */
export function MemoryEditor({
  scope,
  read,
  kind,
  hobs,
  writes,
  say,
}: {
  scope: MemoryScope;
  /** The page as it is now, or null for a new page. */
  read: MemoryPageRead | null;
  kind: MemoryKind | null;
  hobs: HobDirectory;
  writes: MemoryWrites;
  say: Say;
}) {
  const navigate = useNavigate();
  const ids = { title: useId(), body: useId() };
  const [draft, setDraft] = useState<EditorDraft>(() =>
    read === null ? newDraft(startingKind(scope, kind)) : draftOf(read.page, memoryKindOf(read.page.path)),
  );
  // The page as the editor opened it: Save writes over this version, even after the read refreshes.
  const [opened] = useState(() => read?.page ?? null);
  const [touched, setTouched] = useState<ReadonlySet<keyof EditorErrors>>(new Set());
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const errors = editorErrors(draft, new Date());
  const shown = (field: keyof EditorErrors) => (touched.has(field) ? errors[field] : undefined);
  const set = (change: Partial<EditorDraft>) => setDraft((was) => ({ ...was, ...change }));
  const blur = (field: keyof EditorErrors) => () => setTouched((was) => new Set([...was, field]));
  const back: MemoryView =
    read === null ? { _tag: "Scope", scope, kind: null } : { _tag: "Page", scope, path: read.page.path, version: null };

  const save = (over?: MemoryVersion | null) => {
    setTouched(ALL_FIELDS);
    if (!editorValid(errors)) return;
    const payload = saveOf(draft, { scope, page: opened });
    writes.save.mutate(over === undefined ? payload : { ...payload, expected: over }, {
      onSuccess: (saved) => {
        const at: MemoryView = { _tag: "Page", scope, path: saved.page.path, version: null };
        const message = read === null ? copy.editor.created : copy.editor.saved({ who: readersOf(scope, hobs) });
        say({ tone: "done", message }, at);
        void navigate({ to: "/memory", search: memorySearchOf(at) });
      },
      onError: (error) =>
        setRefusal(
          memoryPageChanged(error) && read !== null
            ? { _tag: "Changed", current: memoryVersionNow(error) }
            : {
                _tag: "Failed",
                message: memoryPageChanged(error)
                  ? copy.editor.taken
                  : memoryNotAnswering(error)
                    ? copy.editor.notAnswering
                    : copy.editor.failed,
              },
        ),
    });
  };
  const theirs =
    read !== null && refusal?._tag === "Changed" && read.page.version === refusal.current ? read.page.author : null;

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      className="flex flex-wrap items-start gap-7"
    >
      <div className="flex min-w-0 max-w-[700px] flex-[1_1_520px] flex-col gap-3.5">
        <nav aria-label={copy.page.breadcrumb} className="flex items-center gap-1.5 text-detail text-text-secondary">
          <Link to="/memory" search={memorySearchOf({ _tag: "Scope", scope, kind: null })} className="text-link">
            {scopeName(scope, hobs)}
          </Link>
          <span aria-hidden>›</span>
          <span>{read === null ? copy.editor.newPage : copy.editor.editing}</span>
        </nav>
        <label htmlFor={ids.title} className="lbl text-label">
          {copy.editor.title}
        </label>
        <Input
          id={ids.title}
          value={draft.title}
          aria-invalid={shown("title") !== undefined}
          onChange={(event) => set({ title: event.target.value })}
          onBlur={blur("title")}
          variant="title"
        />
        {shown("title") !== undefined && <p className="m-0 text-ui text-rose">{shown("title")}</p>}
        <span className="lbl text-label">{copy.editor.kind}</span>
        {read === null ? (
          <SegmentedControl<MemoryKind>
            aria-label={copy.editor.kind}
            value={draft.kind}
            onValueChange={(next) => set({ kind: next })}
            className="self-start"
          >
            {WRITABLE_KINDS.map((each) => (
              <SegmentedControlItem key={each} value={each}>
                {copy.kinds[each].one}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        ) : (
          <span className="self-start">
            <KindTag kind={draft.kind} />
          </span>
        )}
        <label htmlFor={ids.body} className="lbl text-label">
          {copy.editor.body}
        </label>
        <Textarea
          id={ids.body}
          rows={11}
          value={draft.body}
          aria-invalid={shown("body") !== undefined}
          onChange={(event) => set({ body: event.target.value })}
          onBlur={blur("body")}
          text="mono"
        />
        <span className="text-meta text-label">{shown("body") ?? copy.editor.bodyHint}</span>
        {refusal !== null && (
          <RefusalLine
            refusal={refusal}
            who={authorName(theirs, hobs)}
            busy={writes.save.isPending}
            onSaveOver={() => save(refusal._tag === "Changed" ? refusal.current : undefined)}
            onSeeTheirs={() => void navigate({ to: "/memory", search: memorySearchOf(back) })}
          />
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={writes.save.isPending}>
            {writes.save.isPending ? copy.editor.saving : copy.editor.save}
          </Button>
          <Button variant="quiet" asChild>
            <Link to="/memory" search={memorySearchOf(back)}>
              {copy.editor.cancel}
            </Link>
          </Button>
          <span className="text-detail text-label">{copy.editor.keptHint({ who: readersOf(scope, hobs) })}</span>
        </div>
      </div>
      <EditorSettings
        scope={scope}
        hobs={hobs}
        draft={draft}
        today={localDay(new Date())}
        error={shown("forgetOn")}
        onChange={set}
        onBlurDay={blur("forgetOn")}
      />
    </form>
  );
}

/** Why Save wrote nothing, and what you can do: save over a hob's newer version, or read it. */
function RefusalLine({
  refusal,
  who,
  busy,
  onSaveOver,
  onSeeTheirs,
}: {
  refusal: Refusal;
  who: string;
  busy: boolean;
  onSaveOver: () => void;
  onSeeTheirs: () => void;
}) {
  if (refusal._tag === "Failed") {
    return (
      <p role="alert" className="m-0 text-ui text-rose">
        {refusal.message}
      </p>
    );
  }
  return (
    <div role="alert" className="flex flex-col gap-2.5 rounded-card bg-notice px-3.5 py-3 text-ui">
      <span className="text-text-strong">{copy.editor.changed({ who })}</span>
      <span className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onSaveOver}>
          {copy.editor.saveOver}
        </Button>
        <Button type="button" variant="quiet" size="sm" onClick={onSeeTheirs}>
          {copy.editor.seeTheirs}
        </Button>
      </span>
    </div>
  );
}
