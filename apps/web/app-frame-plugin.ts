import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type Plugin, runnerImport } from "vite";

/** Where index.html asks for the frame. */
const FRAME_SLOT = "<!--app-frame-->";

const FRAME_MODULE = "./src/components/shell/app-frame.tsx";

/**
 * Renders the window frame (src/components/shell/app-frame.tsx) into index.html, in development and
 * in the build, so the window paints it before the app's code loads: the app-shell pattern, written
 * once as a React component. The frame is rendered again when a file it is made of changes.
 */
export const appFrame = (): Plugin => {
  let markup: Promise<string> | undefined;
  let files = new Set<string>();
  const render = async () => {
    const { module, dependencies } = await runnerImport<typeof import("./src/components/shell/app-frame.tsx")>(
      FRAME_MODULE,
      { configFile: false, logLevel: "error" },
    );
    files = new Set(dependencies);
    return renderToStaticMarkup(createElement(module.AppFrame));
  };
  return {
    name: "hobbots:app-frame",
    transformIndexHtml: {
      order: "pre",
      handler: async (html, context) => {
        // Setup's local pages have their own entry, and no frame.
        if (!context.filename.endsWith("index.html") || !html.includes(FRAME_SLOT)) return html;
        markup ??= render();
        return html.replace(FRAME_SLOT, await markup);
      },
    },
    hotUpdate({ file }) {
      if (files.has(file)) markup = undefined;
    },
  };
};
