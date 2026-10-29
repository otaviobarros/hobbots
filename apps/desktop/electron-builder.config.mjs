/** @type {import("electron-builder").Configuration} */
export default {
  appId: "ai.hobbots.desktop",
  productName: "Hobbots",
  // Outside dist/ and out/, which Turborepo caches as build outputs.
  directories: { output: "release" },
  // Everything the main process needs is bundled into out/ by electron-vite. Claude Code is not
  // shipped: the server runs the one installed on the host.
  files: ["out/**", "package.json"],
  npmRebuild: false,
  extraResources: [{ from: "../web/dist", to: "web" }],
  mac: {
    target: [{ target: "dir", arch: process.arch }],
    category: "public.app-category.productivity",
    // Ad-hoc signed, with no certificate: keeps the bundle's seal valid so macOS offers to open
    // a downloaded copy rather than calling it damaged. Real signing and notarization come later.
    identity: "-",
    hardenedRuntime: false,
  },
};
