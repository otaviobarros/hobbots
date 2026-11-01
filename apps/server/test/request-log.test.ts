import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer, Logger, References } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isRoutineRead, QuietRoutineReads } from "../src/request-log.ts";

const logged: Array<{ url: unknown; status: unknown }> = [];
let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;

beforeAll(() => {
  const capture = Logger.make(({ fiber }) => {
    const annotations = fiber.getRef(References.CurrentLogAnnotations);
    logged.push({ url: annotations["http.url"], status: annotations["http.status"] });
  });
  const web = HttpRouter.toWebHandler(
    Layer.mergeAll(
      HttpRouter.add("GET", "/api/approvals", HttpServerResponse.json([])),
      HttpRouter.add("GET", "/api/missing", HttpServerResponse.empty({ status: 404 })),
      HttpRouter.add("POST", "/api/agents", HttpServerResponse.json({}, { status: 201 })),
      HttpRouter.add("GET", "/api/broken", Effect.die("broken")),
      QuietRoutineReads,
      Logger.layer([capture]),
    ).pipe(Layer.provide(NodeHttpServer.layerHttpServices)),
  );
  handler = (request) => web.handler(request);
  dispose = web.dispose;
});

afterAll(() => dispose());

const send = (method: string, path: string) => handler(new Request(`http://localhost:4317${path}`, { method }));

describe("the request log", () => {
  // covers DP-002
  it("[TC-DP-044] leaves successful reads out and logs writes and failures", async () => {
    await send("GET", "/api/approvals");
    await send("GET", "/api/missing");
    await send("POST", "/api/agents");
    await send("GET", "/api/broken");
    expect(logged).toEqual([
      { url: "/api/missing", status: 404 },
      { url: "/api/agents", status: 201 },
      { url: "/api/broken", status: 500 },
    ]);
  });

  it("counts only GET and HEAD answered below 400 as routine", () => {
    expect(isRoutineRead("GET", 200)).toBe(true);
    expect(isRoutineRead("HEAD", 304)).toBe(true);
    expect(isRoutineRead("GET", 404)).toBe(false);
    expect(isRoutineRead("POST", 200)).toBe(false);
  });
});
