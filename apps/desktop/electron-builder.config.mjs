/** @type {import("electron-builder").Configuration} */
export default {
  // CFBundleIdentifier. The data folder follows the product name, not this, so it is unaffected.
  appId: "ai.hobbots.app",
  productName: "Hobbots",
  // Shown by Finder's Get Info and the About panel; the version comes from package.json.
  copyright: "Copyright © 2026 The Hobbots contributors. Licensed under the Apache License 2.0.",
  // Outside dist/ and out/, which Turborepo caches as build outputs.
  directories: { output: "release", buildResources: "resources" },
  // Everything the main process needs is bundled into out/ by electron-vite. Claude Code is not
  // shipped: the server runs the one installed on the host.
  files: ["out/**", "package.json"],
  npmRebuild: false,
  extraResources: [
    { from: "../web/dist", to: "web" },
    { from: "../../LICENSE", to: "LICENSE" },
  ],
  mac: {
    target: [{ target: "dir", arch: process.arch }],
    category: "public.app-category.productivity",
    // Generated from the crest by scripts/app-icon.ts.
    icon: "resources/icon.icns",
    // Ad-hoc signed, with no certificate: keeps the bundle's seal valid so macOS offers to open
    // a downloaded copy rather than calling it damaged. Real signing and notarization come later.
    identity: "-",
    hardenedRuntime: false,
  },
};
