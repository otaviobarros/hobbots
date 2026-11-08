import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import { ActivityRepository, HobbotsRepository, SecretRedaction, TaskFiles } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  ArtifactId,
  ArtifactRef,
  Attempt,
  AttemptActivity,
  AttemptId,
  FileChange,
  FileChangeId,
  type FileChangeKind,
  PREVIEW_TEXT_BYTES,
  SERVED_FILE_BYTES,
  TaskId,
} from "@hobbots/domain";
import { HobbotsRepositoryLive, SetupRepository } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { HobFilesLive } from "@hobbots/workbench";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { HttpRouter } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";
import { TaskFileRoute } from "../src/task-files.ts";
import { AS_WINDOW, TestDevices } from "./window-device.ts";

// Issue #388: the files a Task made or touched, listed and served for the Workbench's Files tab
// (ADR 023), with the hub's own use case and route over real files in a real folder. Only files
// inside the hob's folders are listed or served.

const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-task-files-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const project = join(temp, "project");
/** A folder the hob does not work in. */
const outside = join(temp, "outside");
/** A folder the hob worked in once, and no longer does. */
const former = join(temp, "former");

const AT = "2026-11-02T10:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const TASK = TaskId.make("t1");
const ATTEMPT = AttemptId.make("a1");
const HUB_SECRET = "hub-credential-0123456789";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF = "%PDF-1.4\n%%EOF\n";
/** A log longer than a preview shows, with the hub's credential across the point where the preview is cut. */
const LONG = `${"x".repeat(99)}\n`
  .repeat(Math.floor((PREVIEW_TEXT_BYTES - 30) / 100))
  .padEnd(PREVIEW_TEXT_BYTES - 20, "y");
const LONG_LOG = `${LONG}\ntoken ${HUB_SECRET}\nmore\n`;
/** An export larger than the hub serves, as the Task left it; it is rewritten after, at the same size. */
const EXPORT = new Uint8Array(SERVED_FILE_BYTES + 1);

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

const write = (folder: string, path: string, contents: string | Uint8Array) => {
  mkdirSync(join(folder, path, ".."), { recursive: true });
  writeFileSync(join(folder, path), contents);
};

/** A change the Attempt recorded, leaving `left` in the file. */
const change = (path: string, kind: FileChangeKind, left: string | Uint8Array | null, folder = project) =>
  new FileChange({
    id: FileChangeId.make(`c-${path}`),
    attemptId: ATTEMPT,
    taskId: TASK,
    folder,
    path,
    kind,
    movedFrom: null,
    before: null,
    after:
      left === null ? null : { hash: sha256(left), size: left.length, kind: "text", contentId: null, notKept: null },
    sharedWith: [],
    settled: true,
    recordedAt: AT,
  });

const artifact = (id: string, label: string, value: string, kind: ArtifactRef["kind"] = "file") =>
  new ArtifactRef({ id: ArtifactId.make(id), taskId: TASK, attemptId: ATTEMPT, kind, label, value, createdAt: AT });

const activity = new AttemptActivity({
  attempt: new Attempt({
    id: ATTEMPT,
    taskId: TASK,
    number: 1,
    agentId: ALDRIC,
    runtime: "claude-code",
    sessionId: null,
    configVersion: 1,
    policyVersion: null,
    state: "completed",
    outcome: null,
    startedAt: AT,
    endedAt: AT,
  }),
  commands: [],
  changes: [
    change("report.md", "added", `# Report\n\nUsed ${HUB_SECRET}.\n`),
    change("chart.png", "added", PNG),
    change("brief.pdf", "added", PDF),
    change("page.html", "added", "<script>alert(1)</script>\n"),
    change("data.bin", "added", "\u0000\u0001"),
    change("notes.txt", "edited", "first\n"),
    change("removed.txt", "deleted", null),
    change("later.txt", "added", "gone soon\n"),
    change(".env", "edited", "API_TOKEN=x\n"),
    change("escape.txt", "added", "outside\n"),
    change("old.txt", "added", "old\n", former),
    change("long.log", "added", LONG_LOG),
    change("export.bin", "added", EXPORT),
  ],
  scans: [],
  artifacts: [
    artifact("made-report", "The report", join(project, "report.md")),
    artifact("made-relative", "Summary", "summary.txt"),
    artifact("made-outside", "Elsewhere", join(outside, "secret.txt")),
    artifact("made-link", "A link", "https://hobbots.app", "link"),
  ],
  sharedWithHobs: [],
  detailsClearedAt: null,
});

const Records = Layer.succeed(
  ActivityRepository,
  // The Files tab reads only an Attempt's records.
  ActivityRepository.of({
    read: (attemptId: AttemptId) => Effect.succeed(attemptId === ATTEMPT ? Option.some(activity) : Option.none()),
  } as unknown as ActivityRepository["Service"]),
);

const Seed = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* (yield* SetupRepository).update({ safetyPreset: "balanced", approvedFolders: [project] });
    yield* (yield* HobbotsRepository).insertAgent(
      new Agent({
        id: ALDRIC,
        name: "Aldric",
        roleTitle: "Writer",
        runtime: "claude-code",
        model: null,
        effort: null,
        instructions: "",
        lookSeed: 1,
        lookColor: "moss",
        configVersion: 1,
        createdAt: AT,
      }),
    );
  }),
);

const App = Layer.merge(TaskFiles.layer, TestDevices).pipe(
  Layer.provideMerge(Seed),
  Layer.provideMerge(
    Layer.mergeAll(
      Records,
      HobFilesLive,
      NodeFolderChecks,
      SecretRedaction.layer([{ value: HUB_SECRET, kind: "HUB_TOKEN" }]),
      HobbotsRepositoryLive,
      SetupRepository.layer,
      EventBus.layer,
    ),
  ),
  Layer.provideMerge(TestDatabase),
);

let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<typeof App>, Layer.Error<typeof App>>;
let handler: (request: Request) => Promise<Response>;
beforeAll(async () => {
  write(project, "report.md", `# Report\n\nUsed ${HUB_SECRET}.\n`);
  write(project, "chart.png", PNG);
  write(project, "brief.pdf", PDF);
  write(project, "page.html", "<script>alert(1)</script>\n");
  write(project, "data.bin", "\u0000\u0001");
  write(project, "notes.txt", "changed since\n");
  write(project, "summary.txt", "In short.\n");
  write(project, ".env", "API_TOKEN=x\n");
  write(outside, "secret.txt", "Not for hobs.\n");
  write(former, "old.txt", "old\n");
  write(project, "long.log", LONG_LOG);
  write(
    project,
    "export.bin",
    EXPORT.map((byte, index) => (index === 0 ? 1 : byte)),
  );
  // A link the Task left in its folder, to a file outside every folder of the hob's.
  symlinkSync(join(outside, "secret.txt"), join(project, "escape.txt"));
  runtime = ManagedRuntime.make(App);
  await runtime.runPromise(Effect.void);
  const web = HttpRouter.toWebHandler(
    TaskFileRoute.pipe(
      Layer.provideMerge(Layer.succeedContext(await runtime.context())),
      Layer.provide(NodeHttpServer.layerHttpServices),
    ),
    { disableLogger: true },
  );
  handler = (request) => web.handler(request);
});
afterAll(() => runtime?.dispose());

const list = () => runtime.runPromise(TaskFiles.use((files) => files.list(ATTEMPT)));
const idOf = async (path: string) => {
  const found = (await list()).files.find((file) => file.path === path);
  if (found === undefined) throw new Error(`${path} is not listed`);
  return found.id;
};
const get = async (
  path: string,
  init: { readonly download?: boolean; readonly headers?: Record<string, string> } = {},
) =>
  handler(
    new Request(
      `http://127.0.0.1/api/attempts/${ATTEMPT}/files/${await idOf(path)}${init.download === true ? "?download=1" : ""}`,
      { headers: init.headers ?? AS_WINDOW },
    ),
  );

describe("a Task's files", () => {
  // covers UX-002
  it("[TC-GEN-140] lists what the Task made, then what it changed, each with its preview and how it is now", async () => {
    const listed = await list();
    expect(
      listed.files.map(({ path, label, origin, preview, now }) => ({ path, label, origin, preview, now })),
    ).toEqual([
      { path: "report.md", label: "The report", origin: "made", preview: "markdown", now: "same" },
      { path: "summary.txt", label: "Summary", origin: "made", preview: "text", now: "same" },
      { path: ".env", label: null, origin: "edited", preview: "none", now: "same" },
      { path: "brief.pdf", label: null, origin: "added", preview: "pdf", now: "same" },
      { path: "chart.png", label: null, origin: "added", preview: "image", now: "same" },
      { path: "data.bin", label: null, origin: "added", preview: "none", now: "same" },
      // A file the Task left that is now a link leading out of the folder is not read: it is gone.
      { path: "escape.txt", label: null, origin: "added", preview: "text", now: "gone" },
      // Rewritten at the size the Task left, and too large to read: not taken as the same.
      { path: "export.bin", label: null, origin: "added", preview: "none", now: "unchecked" },
      { path: "later.txt", label: null, origin: "added", preview: "text", now: "gone" },
      { path: "long.log", label: null, origin: "added", preview: "text", now: "same" },
      { path: "notes.txt", label: null, origin: "edited", preview: "text", now: "changed" },
      { path: "page.html", label: null, origin: "added", preview: "text", now: "same" },
    ]);
    const report = listed.files[0];
    expect(report).toMatchObject({ folder: project, location: join(project, "report.md"), notServed: null });
    expect(report?.size).toBe(`# Report\n\nUsed ${HUB_SECRET}.\n`.length);
    // What it holds now versions its preview; a file no longer there has none.
    expect(report?.hash).toBe(sha256(`# Report\n\nUsed ${HUB_SECRET}.\n`));
    expect(listed.files.find((file) => file.path === "later.txt")?.hash).toBeNull();
    // A file the Task deleted is not one it made or touched to show.
    expect(listed.files.some((file) => file.path === "removed.txt")).toBe(false);
  });

  // covers UX-002, PE-005
  it("[TC-GEN-141] previews images, PDF and text, redacted, and downloads the file as it is", async () => {
    const image = await get("chart.png");
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);

    const pdf = await get("brief.pdf");
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(await pdf.text()).toBe(PDF);

    const text = await get("report.md");
    expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(text.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await text.text()).toBe("# Report\n\nUsed [redacted: HUB_TOKEN].\n");

    // A long text is redacted before it is cut, so no part of a credential across the cut is shown.
    const long = await (await get("long.log")).text();
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(PREVIEW_TEXT_BYTES);
    expect(long.startsWith(LONG.slice(0, 1000))).toBe(true);
    for (let end = 4; end <= HUB_SECRET.length; end += 1) expect(long).not.toContain(HUB_SECRET.slice(0, end));

    const download = await get("report.md", { download: true });
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toBe(
      `attachment; filename="report.md"; filename*=UTF-8''report.md`,
    );
    expect(await download.text()).toBe(`# Report\n\nUsed ${HUB_SECRET}.\n`);
  });

  // covers PE-005
  it("[TC-GEN-142] never serves a page a hob wrote as a page, a file with no preview, or a secret file's contents", async () => {
    // HTML is shown as its text, never run on the hub's origin.
    const page = await get("page.html");
    expect(page.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect((await get("page.html", { download: true })).headers.get("content-type")).toBe("application/octet-stream");
    // A file with no preview is only downloaded.
    expect((await get("data.bin")).status).toBe(404);
    expect((await get("data.bin", { download: true })).status).toBe(200);
    // A secret file is listed, but neither previewed nor downloaded.
    const env = (await list()).files.find((file) => file.path === ".env");
    expect(env).toMatchObject({ preview: "none", notServed: "secret" });
    expect((await get(".env")).status).toBe(404);
    expect((await get(".env", { download: true })).status).toBe(404);
    // Gone is gone.
    expect((await get("later.txt", { download: true })).status).toBe(404);
  });

  // covers PE-005
  it("[TC-GEN-143] lists and serves only files inside the hob's folders", async () => {
    const paths = (await list()).files.map((file) => file.location);
    // A result named outside every folder, and a change in a folder the hob no longer works in.
    expect(paths).not.toContain(join(outside, "secret.txt"));
    expect(paths).not.toContain(join(former, "old.txt"));
    // A file the Task left that is now a link leading out is never read through.
    expect((await get("escape.txt")).status).toBe(404);
    expect((await get("escape.txt", { download: true })).status).toBe(404);
    // An id the listing does not name is never served, however it is spelled.
    for (const id of ["made-outside", "c-escape.txt", "c-old.txt", "..%2Foutside%2Fsecret.txt", "nothing"]) {
      const response = await handler(
        new Request(`http://127.0.0.1/api/attempts/${ATTEMPT}/files/${id}?download=1`, { headers: AS_WINDOW }),
      );
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("Not for hobs");
    }
  });

  // covers PE-005
  it("[TC-GEN-144] serves a file only to an approved device", async () => {
    const refused = await get("report.md", { headers: {} });
    expect(refused.status).toBe(401);
    expect(await refused.text()).not.toContain("Report");
    const other = await handler(
      new Request(`http://127.0.0.1/api/attempts/elsewhere/files/${await idOf("report.md")}`, { headers: AS_WINDOW }),
    );
    expect(other.status).toBe(404);
  });
});
