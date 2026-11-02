import { type AttemptId, PREVIEW_TEXT_BYTES, type TaskFile } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { taskFileTextQuery, taskFileUrl } from "../../../api/workbench.ts";
import { formatBytes } from "../../../lib/reply-steps.ts";
import { ReplyMarkdown } from "../../markdown/reply-markdown.tsx";
import { fileName, fileView } from "./files-model.ts";
import { messages } from "./messages.ts";

const NOTE = "m-0 px-4 py-5 text-detail text-secondary-text";

/**
 * A file's preview, as it is now on the hub: an image, a PDF, Markdown rendered as replies are, or
 * plain text. A file with no preview, a secret one, one too large and one no longer there each say
 * so in a sentence, under its name, size and kind.
 */
export function FilePreview({ attemptId, file, stamp }: { attemptId: AttemptId; file: TaskFile; stamp: string }) {
  const view = fileView(file);
  const name = fileName(file);
  if (view.kind === "gone") return <p className={NOTE}>{messages.gone}</p>;
  if (view.kind === "secret") return <p className={NOTE}>{messages.secret}</p>;
  if (view.kind === "too-large") return <p className={NOTE}>{messages.tooLarge}</p>;
  if (view.kind === "no-preview") return <p className={NOTE}>{messages.noPreview}</p>;
  const src = taskFileUrl(attemptId, file.id);
  switch (view.preview) {
    case "image":
      return (
        <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto bg-deep p-4">
          <img src={src} alt={messages.preview({ name })} className="max-w-full [image-rendering:auto]" />
        </div>
      );
    case "pdf":
      return (
        <iframe src={src} title={messages.preview({ name })} className="min-h-[480px] w-full flex-1 border-0 bg-deep" />
      );
    default:
      return <TextPreview attemptId={attemptId} file={file} stamp={stamp} markdown={view.preview === "markdown"} />;
  }
}

function TextPreview({
  attemptId,
  file,
  stamp,
  markdown,
}: {
  attemptId: AttemptId;
  file: TaskFile;
  stamp: string;
  markdown: boolean;
}) {
  const read = useQuery(taskFileTextQuery(attemptId, file.id, `${stamp}|${file.now}|${file.size}`));
  if (read.isPending) return <p className={NOTE}>{messages.previewLoading}</p>;
  if (read.isError) {
    return (
      <p className={`${NOTE} flex items-center gap-3`}>
        <span>{messages.previewFailed}</span>
        <Button variant="chip" size="xs" onClick={() => void read.refetch()}>
          {messages.tryAgain}
        </Button>
      </p>
    );
  }
  const cut = file.size !== null && file.size > PREVIEW_TEXT_BYTES;
  return (
    <div
      aria-label={messages.preview({ name: fileName(file) })}
      role="document"
      className="min-h-0 flex-1 overflow-auto"
    >
      {cut && (
        <p className="m-0 px-4 pt-3 text-xs text-label">{messages.cut({ size: formatBytes(PREVIEW_TEXT_BYTES) })}</p>
      )}
      {markdown ? (
        <div className="max-w-[68ch] px-5 py-4">
          <ReplyMarkdown content={read.data} streaming={false} caret={false} />
        </div>
      ) : (
        <pre className="m-0 px-4 py-3 font-mono text-xs leading-normal whitespace-pre-wrap break-all text-text">
          {read.data}
        </pre>
      )}
    </div>
  );
}
