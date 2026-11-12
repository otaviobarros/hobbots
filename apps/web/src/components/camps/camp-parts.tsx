import { Switch } from "@hobbots/ui/components/switch";
import { type ReactNode, useId } from "react";

/** A field of a camp sheet: its label, the control, then its note, or its problem once shown. */
export function CampField({
  label,
  note,
  problem,
  children,
}: {
  label: string;
  note?: string | undefined;
  problem?: string | undefined;
  /** The control, given the ids that tie it to its label and note. */
  children: (ids: { readonly id: string; readonly noteId: string }) => ReactNode;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="lbl text-meta text-label">
        {label}
      </label>
      {children({ id, noteId })}
      {problem !== undefined ? (
        <span id={noteId} role="alert" className="text-meta text-rose">
          {problem}
        </span>
      ) : (
        note !== undefined && (
          <span id={noteId} className="text-meta text-label">
            {note}
          </span>
        )
      )}
    </div>
  );
}

/** What a sheet says comes along, as a row with a switch: on and fixed for what always comes. */
export function AlongRow({
  title,
  detail,
  checked,
  onChange,
}: {
  title: string;
  detail: string;
  checked: boolean;
  /** Left out for what always comes along, whose switch stays on. */
  onChange?: ((checked: boolean) => void) | undefined;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-3 rounded-control bg-card px-3 py-2.5 border-(length:--edge) border-line">
      <span className="flex min-w-0 flex-1 flex-col">
        <label htmlFor={id} className="text-ui font-semibold text-text-strong">
          {title}
        </label>
        <span id={`${id}-detail`} className="text-meta text-label">
          {detail}
        </span>
      </span>
      <Switch
        id={id}
        checked={checked}
        disabled={onChange === undefined}
        aria-describedby={`${id}-detail`}
        onCheckedChange={onChange}
      />
    </div>
  );
}

/** One thing a sheet lists, such as an open item Start fresh carries over. */
export function ListedRow({ title, detail }: { title: string; detail: string }) {
  return (
    <li className="flex flex-col rounded-control bg-card px-3 py-2.5 border-(length:--edge) border-line">
      <span className="text-ui font-semibold text-text-strong">{title}</span>
      <span className="text-meta text-label">{detail}</span>
    </li>
  );
}
