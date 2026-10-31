import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://hobbots.app",
  // Pages are prerendered; only the wait-list action runs on the Worker.
  output: "static",
  // No sessions, so the adapter provisions no KV namespace.
  session: false,
  // Images ship as they are, so no Cloudflare Images binding is needed.
  adapter: cloudflare({ imageService: "passthrough" }),
});
