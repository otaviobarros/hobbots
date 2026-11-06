import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeSharedWrite } from "./linux-permissions.ts";

const mode = async (path: string) => (await stat(path)).mode & 0o7777;

describe("removeSharedWrite", () => {
  let folder = "";
  afterEach(() => rm(folder, { recursive: true, force: true }));

  it("leaves only the owner able to write, keeping every other bit", async () => {
    folder = await mkdtemp(join(tmpdir(), "hobbots-permissions-"));
    await mkdir(join(folder, "resources"));
    await writeFile(join(folder, "hobbots"), "");
    await writeFile(join(folder, "resources", "app.asar"), "");
    await writeFile(join(folder, "chrome-sandbox"), "");
    await chmod(join(folder, "resources"), 0o777);
    await chmod(join(folder, "hobbots"), 0o777);
    await chmod(join(folder, "resources", "app.asar"), 0o666);
    await chmod(join(folder, "chrome-sandbox"), 0o4755);
    await symlink("hobbots", join(folder, "link"));

    await removeSharedWrite(folder);

    expect(await mode(join(folder, "resources"))).toBe(0o755);
    expect(await mode(join(folder, "hobbots"))).toBe(0o755);
    expect(await mode(join(folder, "resources", "app.asar"))).toBe(0o644);
    expect(await mode(join(folder, "chrome-sandbox"))).toBe(0o4755);
  });
});
