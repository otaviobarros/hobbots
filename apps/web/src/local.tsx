import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { setupBridge } from "./components/connect/connect-model.ts";
import { LocalSetup } from "./components/connect/local-setup.tsx";
import { messages } from "./components/connect/messages.ts";
import { followMotionChoice } from "./lib/motion.ts";
import { followTextSizeChoice } from "./lib/text-size.ts";
import { followThemeChoice } from "./lib/theme.ts";
import "./styles.css";

/**
 * Setup's local pages (ADR 025): the desktop app serves them from its own resources on a computer that
 * is not a hub yet, so they call no API and talk only to the app's setup bridge.
 */
followMotionChoice();
followThemeChoice();
followTextSizeChoice();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
const bridge = setupBridge();
// A computer that has used Hobbots before, such as one that disconnected from its hub, starts at
// Where Hobbots runs rather than Welcome.
const start = new URLSearchParams(globalThis.location.search).get("start") === "where" ? "where" : "welcome";

createRoot(root).render(
  <StrictMode>
    <div className="flex h-screen min-h-[610px] flex-col bg-ground text-text-strong">
      {/* Window chrome: macOS draws the traffic lights over the left of this bar. */}
      <header className="flex h-[30px] flex-none items-center justify-center bg-deep text-[13px] text-label [-webkit-app-region:drag]">
        Hobbots
      </header>
      {bridge === undefined ? (
        <p className="m-auto text-text-secondary">{messages.noBridge}</p>
      ) : (
        <LocalSetup bridge={bridge} start={start} />
      )}
    </div>
  </StrictMode>,
);
