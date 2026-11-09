import type { ServerResponse } from "node:http";
import { standInServer } from "./stand-in-server.ts";

// A stand-in for the Messages API, as the ADR 029 probe used: Claude Code reaches it through
// `ANTHROPIC_BASE_URL`, each request is recorded, and the model's moves are fixed.

export interface MessagesRequest {
  readonly system?: unknown;
  readonly messages?: ReadonlyArray<unknown>;
  readonly tools?: ReadonlyArray<{ readonly name?: string; readonly type?: string }>;
}

/** A hit the stand-in's web search finds, as Anthropic's `web_search` server tool reports one. */
export interface SearchHit {
  readonly title: string;
  readonly url: string;
}

/** What the stand-in model does: say something, or call a tool. */
export type MessagesMove =
  | { readonly say: string }
  | { readonly tool: string; readonly input: Record<string, unknown> };

const sse = (response: ServerResponse, event: Record<string, unknown>) =>
  response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);

/** Opens the stream of message `id`. */
const started = (response: ServerResponse, id: string) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  sse(response, {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
};

const answer = (response: ServerResponse, move: MessagesMove, id: string) => {
  started(response, id);
  if ("say" in move) {
    sse(response, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    sse(response, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: move.say } });
  } else {
    sse(response, {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: `toolu_${id}`, name: move.tool, input: {} },
    });
    sse(response, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(move.input) },
    });
  }
  sse(response, { type: "content_block_stop", index: 0 });
  sse(response, {
    type: "message_delta",
    delta: { stop_reason: "say" in move ? "end_turn" : "tool_use", stop_sequence: null },
    usage: { output_tokens: 5 },
  });
  sse(response, { type: "message_stop" });
  response.end();
};

/**
 * Anthropic's `web_search` server tool, run on the stand-in: the search Claude Code's `WebSearch`
 * asks for in a request of its own, answered with its query and `hits` as the API streams them.
 */
const searched = (response: ServerResponse, query: string, hits: ReadonlyArray<SearchHit>, id: string) => {
  started(response, id);
  const use = `srvtoolu_${id}`;
  sse(response, {
    type: "content_block_start",
    index: 0,
    content_block: { type: "server_tool_use", id: use, name: "web_search", input: {} },
  });
  sse(response, {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: JSON.stringify({ query }) },
  });
  sse(response, { type: "content_block_stop", index: 0 });
  sse(response, {
    type: "content_block_start",
    index: 1,
    content_block: {
      type: "web_search_tool_result",
      tool_use_id: use,
      content: hits.map((hit) => ({
        type: "web_search_result",
        ...hit,
        encrypted_content: "stand-in",
        page_age: null,
      })),
    },
  });
  sse(response, { type: "content_block_stop", index: 1 });
  sse(response, { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } });
  sse(response, { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: `Found ${query}.` } });
  sse(response, { type: "content_block_stop", index: 2 });
  sse(response, {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 5, server_tool_use: { web_search_requests: 1 } },
  });
  sse(response, { type: "message_stop" });
  response.end();
};

/** The query of a request that offers the `web_search` server tool, from its last user message. */
const searchQuery = (request: MessagesRequest): string | undefined => {
  if (!(request.tools ?? []).some((tool) => tool.type?.startsWith("web_search") === true)) return undefined;
  const text = JSON.stringify(request.messages?.at(-1) ?? "");
  return /query: ([^"\\]+)/.exec(text)?.[1]?.trim() ?? text;
};

/**
 * The stand-in. Claude Code also asks small side questions, such as a title; only requests that carry
 * `marker` in their system prompt are the turn's, and only those take the scripted moves.
 */
export const messagesStandIn = (marker: string) => {
  const moves: Array<MessagesMove> = [];
  const requests: Array<MessagesRequest> = [];
  /** What each web search finds, in order; Claude Code's `WebSearch` asks in a request of its own. */
  const searches: Array<ReadonlyArray<SearchHit>> = [];
  /** The queries searched, in order. */
  const queries: Array<string> = [];
  let served = 0;
  const server = standInServer((request, body, response) => {
    if (!request.url?.startsWith("/v1/messages") || request.url.startsWith("/v1/messages/count_tokens")) {
      response.writeHead(404, { "content-type": "application/json" }).end("{}");
      return;
    }
    const parsed = JSON.parse(body) as MessagesRequest;
    served += 1;
    const query = searchQuery(parsed);
    if (query !== undefined) {
      queries.push(query);
      searched(response, query, searches.shift() ?? [], `m${served}`);
      return;
    }
    const turn = JSON.stringify(parsed.system ?? "").includes(marker);
    if (turn) requests.push(parsed);
    answer(response, (turn ? moves.shift() : undefined) ?? { say: "Nothing scripted." }, `m${served}`);
  });
  return { server, moves, requests, searches, queries };
};
