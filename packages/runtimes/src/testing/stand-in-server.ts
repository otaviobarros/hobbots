import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** A stand-in model's server: `answer` gets each request once its whole body has arrived. */
export const standInServer = (
  answer: (request: IncomingMessage, body: string, response: ServerResponse) => void,
): Server =>
  createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => answer(request, body, response));
  });
