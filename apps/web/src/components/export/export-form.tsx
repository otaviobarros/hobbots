import type { ExportResult } from "@hobbots/api";
import type { ExportScope } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ApiError } from "../../api/client.ts";
import { exportDestinationQuery, useExport } from "../../api/export.ts";
import { formatCount, plural } from "../../lib/format.ts";
import { messages as copy } from "./messages.ts";

/** Why the hub refused the export, as the hub says it for a folder, or the general failure. */
const refusalOf = (error: unknown): string =>
  error instanceof ApiError && error.tag === "InvalidFolder" ? error.message : copy.failed;

function Saved({ result }: { result: ExportResult }) {
  const rows = [
    [copy.held.threads, result.threads],
    [copy.held.quests, result.quests],
    [copy.held.files, result.files],
  ] as const;
  return (
    <div
      role="status"
      className="cut flex flex-col gap-1.5 border-(length:--edge) border-mint bg-card px-3.5 py-3 text-ui"
    >
      <span className="font-bold break-all text-mint">{copy.saved({ folder: result.folder })}</span>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {rows.map(([label, count]) => (
          <div key={label} className="contents">
            <dt className="text-label">{label}</dt>
            <dd className="m-0">{formatCount(count)}</dd>
          </div>
        ))}
      </dl>
      {result.notCopied > 0 && (
        <span className="text-text-secondary">
          {plural(result.notCopied, {
            one: copy.notCopied.one,
            other: copy.notCopied.other({ count: formatCount(result.notCopied) }),
          })}
        </span>
      )}
    </div>
  );
}

/**
 * Where to save an export on the hub, and Export. The folder starts as the hub's Downloads folder;
 * the hub refuses one inside a folder hobs work in.
 */
export function ExportForm({ scope, disabled = false }: { scope: ExportScope | null; disabled?: boolean }) {
  const suggested = useQuery(exportDestinationQuery);
  const exporter = useExport();
  const [typed, setTyped] = useState<string | null>(null);
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const destination = typed ?? suggested.data?.folder ?? "";
  const pending = exporter.isPending;

  return (
    <form
      className="flex flex-col gap-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (scope === null || destination.trim() === "" || pending) return;
        exporter.mutate({ scope, destination: destination.trim() });
      }}
    >
      <label htmlFor={inputId} className="lbl text-meta text-label">
        {copy.destination}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          value={destination}
          onChange={(event) => setTyped(event.target.value)}
          aria-invalid={exporter.isError}
          aria-describedby={exporter.isError ? `${hintId} ${errorId}` : hintId}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          className="min-w-[260px] flex-1 border-(length:--edge) border-control bg-deep px-[11px] py-[7px] font-mono text-ui text-text-strong"
        />
        <Button type="submit" disabled={disabled || scope === null || destination.trim() === "" || pending}>
          {pending ? copy.exporting : copy.export}
        </Button>
      </div>
      <span id={hintId} className="text-detail text-label">
        {copy.destinationHint}
      </span>
      {exporter.isError && (
        <p id={errorId} role="alert" className="m-0 text-ui text-rose">
          {refusalOf(exporter.error)}
        </p>
      )}
      {exporter.data && !pending && <Saved result={exporter.data} />}
    </form>
  );
}
