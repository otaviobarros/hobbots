import { SearchHit } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { DeviceSession } from "./user-session.ts";

export class SearchGroup extends HttpApiGroup.make("search")
  .add(
    // Threads whose title or finished messages contain every word of `q`; retired hobs are left out.
    // Archived threads are found too; their `thread.archivedAt` marks them.
    HttpApiEndpoint.get("search", "/search", {
      query: { q: Schema.String.check(Schema.isMaxLength(200)) },
      success: Schema.Array(SearchHit),
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
