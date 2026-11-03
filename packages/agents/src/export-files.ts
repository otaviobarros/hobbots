import { type ArtifactNotCopied, EXPORT_FILE_BYTES, EXPORT_TOTAL_BYTES } from "@hobbots/domain";
import { Option } from "effect";
import type { Redactor } from "./secrets.ts";

/** The most one copied file, and all of them together, may take in an export (ADR 026). */
export interface ExportLimits {
  readonly file: number;
  readonly total: number;
}

export const EXPORT_LIMITS: ExportLimits = { file: EXPORT_FILE_BYTES, total: EXPORT_TOTAL_BYTES };

/** Why `size` more bytes do not fit, when the export already holds `total`; none when they do. */
export const overLimits = (size: number, total: number, limits: ExportLimits): Option.Option<ArtifactNotCopied> => {
  if (size > limits.file) return Option.some("too-large");
  if (total + size > limits.total) return Option.some("export-full");
  return Option.none();
};

const utf8 = new TextDecoder("utf-8", { fatal: true });
const bytesAsText = new TextDecoder("latin1");
const encoder = new TextEncoder();

/**
 * What an export writes for a file artifact's bytes (ADR 026: every string is redacted), or why it
 * writes nothing. UTF-8 text goes through the redactor like any other string. Any other file is
 * copied as it is only when the redactor finds nothing in it read byte by byte, since a token in a
 * binary file is still ASCII. The limits apply to what is written: a redaction marker can be
 * longer than the secret it replaces.
 */
export const exportedContents = (
  redactor: Redactor,
  bytes: Uint8Array,
  total: number,
  limits: ExportLimits,
):
  | { readonly _tag: "Copy"; readonly bytes: Uint8Array }
  | { readonly _tag: "Skip"; readonly why: ArtifactNotCopied } => {
  const text = Option.liftThrowable(() => utf8.decode(bytes))().pipe(Option.filter((each) => !each.includes("\0")));
  let contents = bytes;
  if (Option.isSome(text)) contents = encoder.encode(redactor.text(text.value));
  else {
    const raw = bytesAsText.decode(bytes);
    if (redactor.text(raw) !== raw) return { _tag: "Skip", why: "holds-secret" };
  }
  return Option.match(overLimits(contents.length, total, limits), {
    onNone: () => ({ _tag: "Copy", bytes: contents }),
    onSome: (why) => ({ _tag: "Skip", why }),
  });
};
