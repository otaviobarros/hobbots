import { Layer } from "effect";

/**
 * What only a build of the hub for the browser tests adds: none here. The browser tests' build
 * replaces this module with `testing/people.ts` (see apps/web/e2e/global-setup.ts), so the desktop
 * app and every other build of the hub carry no test seam at all.
 */
export const testSeams = (_dataDir: string) => Layer.empty;
