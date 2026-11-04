import { FuseState, FuseV1Options } from "@electron/fuses";
import { describe, expect, it } from "vitest";
import { electronFuses, fuseProblems } from "./electron-fuses.ts";

const { ENABLE: on, DISABLE: off } = FuseState;

describe("Electron's fuses", () => {
  it("are the ones the packaged app ships with (STD-DESKTOP-007)", () => {
    expect(electronFuses).toMatchObject({
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      enableCookieEncryption: true,
      grantFileProtocolExtraPrivileges: false,
    });
  });

  it("are read back from the built app, naming each that differs", () => {
    const shipped = {
      [FuseV1Options.RunAsNode]: on,
      [FuseV1Options.EnableCookieEncryption]: on,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: off,
      [FuseV1Options.EnableNodeCliInspectArguments]: off,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: on,
      [FuseV1Options.OnlyLoadAppFromAsar]: on,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: off,
    };
    expect(fuseProblems(shipped)).toEqual([]);
    const { [FuseV1Options.OnlyLoadAppFromAsar]: _missing, ...partial } = shipped;
    expect(fuseProblems({ ...partial, [FuseV1Options.EnableNodeCliInspectArguments]: on })).toEqual([
      "enableNodeCliInspectArguments is on, expected off",
      "onlyLoadAppFromAsar is missing, expected on",
    ]);
  });
});
