import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

// A stand-in for the Responses API, as the ADR 024 probe used: the model's moves are fixed, and each
// request is recorded. Codex reaches it as a custom model provider.

export interface ModelRequest {
  readonly input: ReadonlyArray<{ readonly role?: string; readonly content?: unknown }>;
  readonly instructions?: string;
  readonly tools?: ReadonlyArray<{ readonly name?: string; readonly type?: string }>;
}

/**
 * What the stand-in model does with the next request: say something, call a tool (a Responses API
 * output item), or hang until the client leaves.
 */
export type Move = { readonly say: string } | { readonly call: Record<string, unknown> } | { readonly hang: true };

const sse = (response: ServerResponse, event: Record<string, unknown>) =>
  response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);

const say = (response: ServerResponse, text: string, id: string) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  sse(response, { type: "response.created", response: { id } });
  const item = { type: "message", role: "assistant", id: `msg-${id}`, content: [{ type: "output_text", text }] };
  sse(response, { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } });
  for (const part of [text.slice(0, 3), text.slice(3)]) {
    sse(response, {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: part,
    });
  }
  sse(response, { type: "response.output_item.done", output_index: 0, item });
  sse(response, {
    type: "response.completed",
    response: {
      id,
      usage: {
        input_tokens: 120,
        input_tokens_details: { cached_tokens: 20 },
        output_tokens: 7,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 127,
      },
    },
  });
  response.end();
};

const callTool = (response: ServerResponse, item: Record<string, unknown>, id: string) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  sse(response, { type: "response.created", response: { id } });
  sse(response, { type: "response.output_item.added", output_index: 0, item });
  sse(response, { type: "response.output_item.done", output_index: 0, item });
  sse(response, {
    type: "response.completed",
    response: {
      id,
      usage: {
        input_tokens: 1,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 1,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 2,
      },
    },
  });
  response.end();
};

/** A function tool the stand-in model calls, such as a hub tool or Codex's shell. */
export const functionCall = (name: string, input: Record<string, unknown>, callId = `call-${name}`): Move => ({
  call: { type: "function_call", id: `fc-${callId}`, call_id: callId, name, arguments: JSON.stringify(input) },
});

/** A command the stand-in model runs with Codex's shell tool. */
export const runs = (callId: string, cmd: string): Move => functionCall("exec_command", { cmd }, callId);

/** A file the stand-in model adds with Codex's patch tool. */
export const adds = (callId: string, file: string, line: string): Move => ({
  call: {
    type: "custom_tool_call",
    id: `ct-${callId}`,
    call_id: callId,
    name: "apply_patch",
    input: `*** Begin Patch\n*** Add File: ${file}\n+${line}\n*** End Patch\n`,
  },
});

export const standIn = () => {
  const moves: Array<Move> = [];
  const requests: Array<ModelRequest> = [];
  let served = 0;
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (!request.url?.endsWith("/responses")) {
        response.writeHead(404).end();
        return;
      }
      requests.push(JSON.parse(body) as ModelRequest);
      const move = moves.shift() ?? { say: "Nothing scripted." };
      served += 1;
      if ("hang" in move) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        sse(response, { type: "response.created", response: { id: `r${served}` } });
        return;
      }
      if ("call" in move) {
        callTool(response, move.call, `r${served}`);
        return;
      }
      say(response, move.say, `r${served}`);
    });
  });
  return { server, moves, requests };
};

export const textOf = (request: ModelRequest | undefined) => JSON.stringify(request?.input ?? []);
