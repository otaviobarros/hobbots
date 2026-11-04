import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { noteRefusal, retryUnlessRefused } from "./api/live.ts";
import { followMotionChoice } from "./lib/motion.ts";
import { followTextSizeChoice } from "./lib/text-size.ts";
import { followThemeChoice } from "./lib/theme.ts";
import { followWindowFocus } from "./lib/window-focus.ts";
import { createAppRouter } from "./router.tsx";
import "./styles.css";

// A read or a change the hub refuses as revoked shows the removed screen (ADR 021); a read notes
// the refusal on its first failure, before any retry could hide it.
const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (error) => noteRefusal(queryClient, error) }),
  mutationCache: new MutationCache({ onError: (error) => noteRefusal(queryClient, error) }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (failures, error) => retryUnlessRefused(queryClient, failures, error),
    },
  },
});
const router = createAppRouter(queryClient);
followWindowFocus();
followMotionChoice();
followThemeChoice();
followTextSizeChoice();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
