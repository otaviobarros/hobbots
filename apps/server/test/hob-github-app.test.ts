import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import {
  ApprovalService,
  ChatService,
  GrantService,
  HobAdmission,
  HobbotsRepository,
  HobLifecycle,
  HobService,
  PermissionSummary,
  SecretRedaction,
} from "@hobbots/agents";
import { HobAppKeys, HobAppKeysMemory, HobGitHubAppLive } from "@hobbots/charms";
import { type FakeGitHub, startFakeGitHub } from "@hobbots/charms/testing";
import { Agent, AgentId } from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import {
  ApprovalRepositoryLive,
  BackpackLive,
  EventJournal,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  HobGitHubAppRepository,
  SearchIndex,
  SetupRepository,
  TaskRepositoryLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TailnetPeer, TailnetPeers } from "../src/devices.ts";
import { EventBus } from "../src/event-bus.ts";
import { CanonicalSharedFolders, NodeFolderChecks } from "../src/folders.ts";
import { HobGitHubAppPages } from "../src/hob-github-app.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { HobToolsLive } from "../src/tools.ts";
import { AS_WINDOW, testDevicesWith } from "./window-device.ts";

// A hob's own GitHub App over the hub's routes (#223, ADR 022): the Charms tab's API, the page that
// posts the manifest and GitHub's redirect back, against the fake GitHub of #325. CI runs it on
// SQLite and on PostgreSQL.
const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-hob-app-")));
const dataDir = join(temp, "hub", "data");
mkdirSync(dataDir, { recursive: true });

const HUB = "localhost:4366";
const FRODO = AgentId.make("frodo");
const MERRY = AgentId.make("merry");

// A test names the Tailscale node a request comes from with this header; without it, it is local.
const NODE_HEADER = "x-test-tailnet-node";
const TestPeers = Layer.succeed(TailnetPeers, {
  peerOf: (request) =>
    Effect.succeed(
      Option.map(
        Option.fromNullishOr(request.headers[NODE_HEADER]),
        (nodeId): TailnetPeer => ({ nodeId, nodeName: "phone", owner: { _tag: "User", login: "you@example.com" } }),
      ),
    ),
});

let github: FakeGitHub;
let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;
let readKey: (agentId: AgentId) => Promise<string | null>;
/** Every body the hub answered, to look for a secret in what a client reads. */
const answered: Array<string> = [];

const hob = (id: AgentId, name: string) =>
  new Agent({
    id,
    name,
    roleTitle: "Guide",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: "2026-11-02T00:00:00.000Z",
  });

beforeAll(async () => {
  github = await startFakeGitHub({ folder: join(temp, "github"), login: "otaviobarros" });
  const HobApp = HobGitHubAppLive(github.hosts).pipe(
    Layer.provideMerge(HobAppKeysMemory),
    Layer.provide([FetchHttpClient.layer, HobGitHubAppRepository]),
  );
  const App = HobLifecycle.layer
    .pipe(Layer.provideMerge(Layer.mergeAll(HobService.layer, PermissionSummary.layer)))
    .pipe(Layer.provideMerge(ChatService.layer))
    .pipe(Layer.provideMerge(ApprovalService.layer))
    .pipe(Layer.provideMerge(GrantService.layer))
    .pipe(Layer.provideMerge(HobToolsLive))
    .pipe(Layer.provideMerge(HobApp))
    .pipe(Layer.provideMerge(CanonicalSharedFolders))
    .pipe(Layer.provideMerge(testDevicesWith(TestPeers)))
    .pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.mergeAll(
            HobbotsRepositoryLive,
            ApprovalRepositoryLive,
            GrantRepositoryLive,
            TaskRepositoryLive,
            EventJournal.layer,
            BackpackLive,
            SetupRepository.layer,
            SearchIndex.layer,
          ).pipe(Layer.provideMerge(TestDatabase)),
          EventBus.layer,
          HobAdmission.layer,
          NodeFolderChecks,
          FakeRuntimeLayer().pipe(Layer.provide(PolicyEngine.node)),
          Layer.succeed(Installation, { app: "hobbots", installationId: "test", version: "0.0.0", dataDir }),
          SecretRedaction.layer([]),
        ),
      ),
    );
  const runtime = ManagedRuntime.make(App);
  await runtime.runPromise(
    Effect.flatMap(HobbotsRepository, (repo) =>
      Effect.andThen(repo.insertAgent(hob(FRODO, "Frodo")), repo.insertAgent(hob(MERRY, "Merry"))),
    ),
  );
  readKey = (agentId) =>
    runtime.runPromise(
      Effect.flatMap(HobAppKeys, (keys) => keys.read(agentId)).pipe(
        Effect.map((key) => (Option.isSome(key) ? "kept" : null)),
      ),
    );
  const web = HttpRouter.toWebHandler(
    Layer.mergeAll(ApiRoutes, HobGitHubAppPages).pipe(
      Layer.provideMerge(Layer.succeedContext(await runtime.context())),
      Layer.provide(NodeHttpServer.layerHttpServices),
    ),
    { disableLogger: true },
  );
  handler = (request) => web.handler(request);
  dispose = async () => {
    await web.dispose();
    await runtime.dispose();
  };
});

afterAll(async () => {
  await dispose();
  await github.close();
  rmSync(temp, { recursive: true, force: true });
});

const send = async (
  method: string,
  url: string,
  headers: Readonly<Record<string, string>> = AS_WINDOW,
  body?: unknown,
): Promise<{ status: number; text: string; headers: Headers }> => {
  const target = new URL(url, `http://${HUB}`);
  const response = await handler(
    new Request(target, {
      method,
      headers: { "content-type": "application/json", host: target.host, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  answered.push(text);
  return { status: response.status, text, headers: response.headers };
};

const api = async <A>(method: string, path: string, headers?: Readonly<Record<string, string>>, body?: unknown) => {
  const response = await send(method, path, headers, body);
  return { status: response.status, body: (response.text ? JSON.parse(response.text) : undefined) as A };
};

const unescapeHtml = (text: string) =>
  text
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

/** What the default browser does with the manifest page: posts its form to GitHub and follows the redirect. */
const throughGitHub = async (page: string) => {
  const action = unescapeHtml(/<form id="manifest" method="post" action="([^"]+)">/.exec(page)?.[1] ?? "");
  const manifest = unescapeHtml(/name="manifest" value="([^"]+)"/.exec(page)?.[1] ?? "");
  const created = await fetch(action, {
    method: "POST",
    body: new URLSearchParams({ manifest }),
    redirect: "manual",
  });
  return {
    action,
    manifest: JSON.parse(manifest) as Record<string, unknown>,
    back: created.headers.get("location") ?? "",
  };
};

interface Started {
  readonly url: string;
  readonly expiresAt: string;
}

describe("A hob's own GitHub App on a hub", () => {
  // covers ADR 022
  it("[TC-GEN-053] is made from the hub's page and GitHub's redirect, and the Charms tab sees it and its installations", async () => {
    const before = await api("GET", `/api/agents/${FRODO}/github-app`);
    expect(before).toEqual({ status: 200, body: { _tag: "None", cannotCreate: null } });

    const started = await api<Started>("POST", `/api/agents/${FRODO}/github-app/start`);
    expect(started.status).toBe(200);
    expect(started.body.url).toMatch(/^http:\/\/127\.0\.0\.1:4366\/github\/hob-app\/new\?state=/);

    // The browser has no device: the page answers for its state alone.
    const page = await send("GET", started.body.url, {});
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("content-security-policy")).toContain(`form-action ${github.base}`);
    const flow = await throughGitHub(page.text);
    expect(flow.action).toMatch(new RegExp(`^${github.base}/settings/apps/new\\?state=`));
    expect(flow.manifest).toMatchObject({
      name: "frodo-hobbots",
      public: false,
      default_events: [],
      redirect_url: "http://127.0.0.1:4366/github/hob-app/callback",
    });
    expect(flow.back).toMatch(/^http:\/\/127\.0\.0\.1:4366\/github\/hob-app\/callback\?code=\w+&state=/);

    const callback = await send("GET", flow.back, {});
    expect(callback.status).toBe(200);
    expect(callback.text).toContain("Frodo has its own GitHub app");
    expect(callback.text).toContain(`${github.base}/apps/frodo-hobbots/installations/new`);
    expect(await readKey(FRODO)).toBe("kept");

    // The same redirect, or the page, again: the state was used.
    expect((await send("GET", flow.back, {})).status).toBe(404);
    expect((await send("GET", started.body.url, {})).status).toBe(404);

    const status = await api<Record<string, unknown>>("GET", `/api/agents/${FRODO}/github-app`);
    expect(status.body).toMatchObject({
      _tag: "Connected",
      app: { slug: "frodo-hobbots", owner: "otaviobarros", clientId: github.apps[0]?.clientId },
      bot: "frodo-hobbots[bot]",
      installUrl: `${github.base}/apps/frodo-hobbots/installations/new`,
      deleteUrl: `${github.base}/settings/apps/frodo-hobbots/advanced`,
    });

    github.installApp("frodo-hobbots", "selected");
    const listed = await api<{ installations: ReadonlyArray<unknown> }>(
      "GET",
      `/api/agents/${FRODO}/github-app/installations`,
    );
    expect(listed.body.installations).toEqual([
      expect.objectContaining({ account: "otaviobarros", repositorySelection: "selected", suspended: false }),
    ]);

    // A second app for the same hob is refused until this one is disconnected.
    const again = await api<{ reason: string }>("POST", `/api/agents/${FRODO}/github-app/start`);
    expect(again).toMatchObject({ status: 409, body: { _tag: "HobGitHubAppRefused", reason: "connected" } });
  });

  // covers ADR 022
  it("[TC-PE-254] starts only from the hub's own computer, and its pages answer nothing for a remote or unknown request", async () => {
    const remote = { ...AS_WINDOW, [NODE_HEADER]: "nPHONE" };
    // The window key is bound to the hub, so a remote request is refused before it asks.
    expect((await api("POST", `/api/agents/${MERRY}/github-app/start`, remote)).status).toBe(401);
    // A request to the hub by another name than loopback cannot be sent back to by GitHub.
    const named = await handler(
      new Request(`http://hub.example.ts.net/api/agents/${MERRY}/github-app/start`, {
        method: "POST",
        headers: { host: "hub.example.ts.net", ...AS_WINDOW },
      }),
    );
    expect(named.status).toBe(409);
    expect(await named.json()).toMatchObject({ reason: "not-local" });

    const started = await api<Started>("POST", `/api/agents/${MERRY}/github-app/start`);
    // The page and callback answer a tailnet request as if the state did not exist.
    expect((await send("GET", started.body.url, { [NODE_HEADER]: "nPHONE" })).status).toBe(404);
    const state = new URL(started.body.url).searchParams.get("state") ?? "";
    expect(
      (await send("GET", `/github/hob-app/callback?code=abc&state=${state}`, { [NODE_HEADER]: "nPHONE" })).status,
    ).toBe(404);
    expect((await send("GET", "/github/hob-app/new?state=made-up", {})).status).toBe(404);
    expect((await send("GET", "/github/hob-app/callback?code=abc&state=made-up", {})).status).toBe(404);
    // Still unused: the local browser can go on.
    expect((await send("GET", started.body.url, {})).status).toBe(200);
    expect((await api("POST", `/api/agents/nobody/github-app/start`)).status).toBe(404);
  });

  // covers ADR 022
  it("[TC-GEN-054] disconnecting and retiring remove the app's installations and key, and link to delete it", async () => {
    github.installApp("frodo-hobbots", "all");
    const disconnected = await api("POST", `/api/agents/${FRODO}/github-app/disconnect`);
    expect(disconnected.body).toEqual({
      deleteUrl: `${github.base}/settings/apps/frodo-hobbots/advanced`,
      problem: null,
    });
    expect(github.apps.find((app) => app.slug === "frodo-hobbots")?.installations).toEqual([]);
    expect(await readKey(FRODO)).toBeNull();
    expect((await api("GET", `/api/agents/${FRODO}/github-app`)).body).toEqual({ _tag: "None", cannotCreate: null });

    // Merry gets an app, then retires: its installations and key go with it.
    const started = await api<Started>("POST", `/api/agents/${MERRY}/github-app/start`);
    const flow = await throughGitHub((await send("GET", started.body.url, {})).text);
    expect((await send("GET", flow.back, {})).status).toBe(200);
    github.installApp("merry-hobbots");
    expect(await readKey(MERRY)).toBe("kept");
    const retired = await api("POST", `/api/agents/${MERRY}/retire`, AS_WINDOW, { activeWork: "stop" });
    expect(retired.status).toBe(200);
    expect(github.apps.find((app) => app.slug === "merry-hobbots")?.installations).toEqual([]);
    expect(await readKey(MERRY)).toBeNull();
    expect((await api("GET", `/api/agents/${MERRY}/github-app`)).body).toEqual({ _tag: "None", cannotCreate: null });
  });

  // covers ADR 022
  it("[TC-PE-255] never answers a client with the app's key, its JWTs or GitHub's other secrets", () => {
    const everything = answered.join("\n");
    expect(github.secrets().length).toBeGreaterThan(0);
    for (const secret of github.secrets()) expect(everything).not.toContain(secret);
    expect(everything).not.toContain("PRIVATE KEY");
  });
});
