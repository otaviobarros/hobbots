import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

// A stand-in for the Messages API, as the ADR 029 probe used: Claude Code reaches it through
// `ANTHROPIC_BASE_URL`, each request is recorded, and the model's moves are fixed.

export interface MessagesRequest {
  readonly system?: unknown;
  readonly messages?: ReadonlyArray<unknown>;
  readonly tools?: ReadonlyArray<{ readonly name?: string }>;
}

/** What the stand-in model does: say something, or call a tool. */
export type MessagesMove =
  | { readonly say: string }
  | { readonly tool: string; readonly input: Record<string, unknown> };

const sse = (response: ServerResponse, event: Record<string, unknown>) =>
  response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);

const answer = (response: ServerResponse, move: MessagesMove, id: string) => {
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
 * The stand-in. Claude Code also asks small side questions, such as a title; only requests that carry
 * `marker` in their system prompt are the turn's, and only those take the scripted moves.
 */
export const messagesStandIn = (marker: string) => {
  const moves: Array<MessagesMove> = [];
  const requests: Array<MessagesRequest> = [];
  let served = 0;
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (!request.url?.startsWith("/v1/messages") || request.url.startsWith("/v1/messages/count_tokens")) {
        response.writeHead(404, { "content-type": "application/json" }).end("{}");
        return;
      }
      const parsed = JSON.parse(body) as MessagesRequest;
      served += 1;
      const turn = JSON.stringify(parsed.system ?? "").includes(marker);
      if (turn) requests.push(parsed);
      answer(response, (turn ? moves.shift() : undefined) ?? { say: "Nothing scripted." }, `m${served}`);
    });
  });
  return { server, moves, requests };
};
