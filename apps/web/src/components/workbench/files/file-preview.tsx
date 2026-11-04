import { type AttemptId, PREVIEW_TEXT_BYTES, type TaskFile } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { taskFileTextQuery, taskFileUrl } from "../../../api/workbench.ts";
import { formatBytes } from "../../../lib/reply-steps.ts";
import { ReplyMarkdown } from "../../markdown/reply-markdown.tsx";
import { fileName, fileView } from "./files-model.ts";
import { messages } from "./messages.ts";

const NOTE = "m-0 px-4 py-5 text-detail text-text-secondary";

type Unshown = Exclude<ReturnType<typeof fileView>["kind"], "preview">;

/**
 * A file's preview, as it is now on the hub: an image, a PDF, Markdown rendered as replies are, or
 * plain text with line numbers. A file with no preview, a secret one, one too large and one no
 * longer there each get a tag and one sentence instead.
 */
export function FilePreview({ attemptId, file }: { attemptId: AttemptId; file: TaskFile }) {
  const view = fileView(file);
  const name = fileName(file);
  if (view.kind !== "preview") return <Sentence kind={view.kind} />;
  // Versioned by what the file holds now, so a live update that changes it loads the new one.
  const src = taskFileUrl(attemptId, file.id, { version: file.hash });
  switch (view.preview) {
    case "image":
      return (
        <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto bg-deep p-5">
          <img
            src={src}
            alt={messages.preview({ name })}
            className="max-w-full rounded-control [image-rendering:auto]"
          />
        </div>
      );
    case "pdf":
      return (
        <iframe src={src} title={messages.preview({ name })} className="min-h-[480px] w-full flex-1 border-0 bg-deep" />
      );
    default:
      return <TextPreview attemptId={attemptId} file={file} markdown={view.preview === "markdown"} />;
  }
}

function TextPreview({ attemptId, file, markdown }: { attemptId: AttemptId; file: TaskFile; markdown: boolean }) {
  const read = useQuery(taskFileTextQuery(attemptId, file.id, file.hash));
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
        <div className="max-w-[620px] px-[22px] py-[18px]">
          <ReplyMarkdown content={read.data} streaming={false} caret={false} />
        </div>
      ) : (
        <NumberedText text={read.data} />
      )}
    </div>
  );
}

/** Plain text with its line numbers, in the same block a diff uses. */
function NumberedText({ text }: { text: string }) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return (
    <div className="m-3 overflow-x-auto rounded-control border border-line bg-panel py-1.5 font-mono text-[12.5px] leading-5">
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, index) => (
            // A line is named by its number, which never moves within one version of the file.
            // biome-ignore lint/suspicious/noArrayIndexKey: the number is the line's identity
            <tr key={index}>
              <td className="w-[42px] pe-2 text-end align-top text-label select-none">{index + 1}</td>
              <td className="pe-4 align-top whitespace-pre-wrap break-all text-text">{line === "" ? " " : line}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Why there is no preview: a tag, then one sentence. */
function Sentence({ kind }: { kind: Unshown }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2.5 px-6 py-12 text-center text-detail text-text-secondary">
      <Badge variant="resting">{messages.unshownTag[kind]}</Badge>
      <p className="m-0 max-w-[420px]">{messages.unshown[kind]}</p>
    </div>
  );
}
