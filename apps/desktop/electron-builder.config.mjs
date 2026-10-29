import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// The Claude Agent SDK runs a native binary from a per-platform package; it cannot run from
// inside the asar archive, so it is copied next to it as a resource.
const require = createRequire(import.meta.url);
const sdkRequire = createRequire(require.resolve("@anthropic-ai/claude-agent-sdk"));
const claudePackage = dirname(
  sdkRequire.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`),
);

/** @type {import("electron-builder").Configuration} */
export default {
  appId: "ai.hobbots.desktop",
  productName: "Hobbots",
  // Outside dist/ and out/, which Turborepo caches as build outputs.
  directories: { output: "release" },
  // Everything the main process needs is bundled into out/ by electron-vite.
  files: ["out/**", "package.json"],
  npmRebuild: false,
  extraResources: [
    { from: "../web/dist", to: "web" },
    { from: join(claudePackage, "claude"), to: "claude/claude" },
  ],
  mac: {
    target: [{ target: "dir", arch: process.arch }],
    category: "public.app-category.productivity",
    // Ad-hoc signed, with no certificate: keeps the bundle's seal valid so macOS offers to open
    // a downloaded copy rather than calling it damaged. Real signing and notarization come later.
    identity: "-",
    hardenedRuntime: false,
    // Claude Code keeps Anthropic's own signature.
    signIgnore: ["Resources/claude/claude$"],
  },
};
