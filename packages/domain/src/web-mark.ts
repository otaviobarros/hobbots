import { Schema } from "effect";

/**
 * The read-the-web mark of a runtime session (ADR 036). Once a hob searches or reads a page, the
 * text it took in stays in its session, so until the session ends whatever could send data out asks
 * first. `since` is when the session first read the web, and `source` the page or search it read
 * last, which a memory save made while the mark holds names as its source.
 */
export const WebReadMark = Schema.Struct({ since: Schema.String, source: Schema.String });
export type WebReadMark = typeof WebReadMark.Type;
