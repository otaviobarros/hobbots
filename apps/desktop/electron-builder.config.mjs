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
    // One installer per architecture rather than a universal build: there are no native modules,
    // so universal would work, but it carries both Electron frameworks and roughly doubles the
    // download for everyone.
    target: [{ target: "dmg", arch: ["arm64", "x64"] }],
    category: "public.app-category.productivity",
    // Ad-hoc signed, with no certificate: keeps the bundle's seal valid so macOS offers to open
    // a downloaded copy rather than calling it damaged. Real signing and notarization come later.
    identity: "-",
    hardenedRuntime: false,
  },
  dmg: {
    artifactName: "${productName}-${version}-${arch}.${ext}",
    // The window shows the app beside an Applications shortcut to drag it onto.
    window: { width: 540, height: 380 },
    contents: [
      { x: 130, y: 220, type: "file" },
      { x: 410, y: 220, type: "link", path: "/Applications" },
    ],
  },
};
