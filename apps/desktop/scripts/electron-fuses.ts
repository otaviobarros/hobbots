/**
 * Electron's fuses as the packaged app ships them (STD-DESKTOP-007). electron-builder flips them
 * (`electronFuses` in electron-builder.config.mjs), and `check-fuses.ts` reads them back from the
 * built app after `package:mac`. Plain TypeScript with no enums, so Node runs it as it is.
 */
import { FuseState, FuseV1Options } from "@electron/fuses";

export const electronFuses = {
  // Still on: the server copies a resumed session's transcript in a child process started as
  // `ELECTRON_RUN_AS_NODE=1` (packages/runtimes). It goes off once that copy no longer needs it.
  runAsNode: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  enableCookieEncryption: true,
  // The app serves no page from file:// (STD-DESKTOP-006), so file:// pages get no extra power.
  grantFileProtocolExtraPrivileges: false,
} as const;

/** Where each fuse sits in the fuse wire `@electron/fuses` reads. */
const WIRE_INDEX: Record<keyof typeof electronFuses, FuseV1Options> = {
  runAsNode: FuseV1Options.RunAsNode,
  enableNodeOptionsEnvironmentVariable: FuseV1Options.EnableNodeOptionsEnvironmentVariable,
  enableNodeCliInspectArguments: FuseV1Options.EnableNodeCliInspectArguments,
  enableEmbeddedAsarIntegrityValidation: FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
  onlyLoadAppFromAsar: FuseV1Options.OnlyLoadAppFromAsar,
  enableCookieEncryption: FuseV1Options.EnableCookieEncryption,
  grantFileProtocolExtraPrivileges: FuseV1Options.GrantFileProtocolExtraPrivileges,
};

/** One line for each fuse in `wire` that differs from `electronFuses`; none when all match. */
export const fuseProblems = (wire: Partial<Record<number, FuseState>>): ReadonlyArray<string> =>
  Object.entries(WIRE_INDEX).flatMap(([name, index]) => {
    const expected = electronFuses[name as keyof typeof electronFuses] ? FuseState.ENABLE : FuseState.DISABLE;
    const found = wire[index];
    if (found === expected) return [];
    const words = (state: FuseState | undefined) =>
      state === FuseState.ENABLE ? "on" : state === FuseState.DISABLE ? "off" : "missing";
    return [`${name} is ${words(found)}, expected ${words(expected)}`];
  });
