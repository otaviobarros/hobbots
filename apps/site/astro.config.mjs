import cloudflare from "@astrojs/cloudflare";
import { defineConfig, envField } from "astro/config";

export default defineConfig({
  site: "https://hobbots.app",
  // Pages are prerendered; only the wait-list action runs on the Worker.
  output: "static",
  // No sessions, so the adapter provisions no KV namespace.
  session: false,
  // Images ship as they are, so no Cloudflare Images binding is needed.
  adapter: cloudflare({ imageService: "passthrough" }),
  env: {
    schema: {
      // Public, read at build time. The default is Cloudflare's test key, which always passes;
      // staging and production builds set their own (see RUNBOOK.md).
      TURNSTILE_SITE_KEY: envField.string({ context: "client", access: "public", default: "1x00000000000000000000AA" }),
    },
  },
});
