import { Button } from "@hobbots/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@hobbots/ui/components/empty";
import { type ErrorComponentProps, Link, useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";
import { ChiefMark } from "../chief/chief-mark.tsx";
import { WindowFrame } from "../shell/app-shell.tsx";
import { messages as copy } from "./messages.ts";
import { failureOf, WAY_OUT_PATHS, type WayOut } from "./route-error-model.ts";

interface RouteErrorProps {
  readonly error: unknown;
  /** Where the screen offers to go instead. Without one, it offers to reload Hobbots. */
  readonly way?: WayOut | undefined;
}

/**
 * Try again loads the route afresh: `router.invalidate()` reruns its checks and loaders and resets
 * the error boundary, so a render error gets another try too.
 */
const useRetry = () => {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const retry = () => {
    setPending(true);
    void router.invalidate().finally(() => setPending(false));
  };
  return { pending, retry };
};

/**
 * The actions: Try again, then the way out. When the thing the page shows is gone, trying again
 * cannot help, so the way out leads.
 */
function Recovery({ error, way }: RouteErrorProps) {
  const { pending, retry } = useRetry();
  const missing = failureOf(error) === "missing" && way !== undefined;
  return (
    <EmptyContent>
      {!missing && (
        <Button onClick={retry} disabled={pending}>
          {pending ? copy.tryingAgain : copy.tryAgain}
        </Button>
      )}
      {way === undefined ? (
        <Button variant="ghost" onClick={() => globalThis.location.reload()}>
          {copy.reload}
        </Button>
      ) : (
        <Button asChild variant={missing ? "default" : "ghost"}>
          <Link to={WAY_OUT_PATHS[way]}>{copy.ways[way]}</Link>
        </Button>
      )}
    </EmptyContent>
  );
}

function ErrorBody({ title, error, way }: RouteErrorProps & { readonly title: string }) {
  const titleId = useId();
  return (
    <Empty size="page" role="alert" aria-labelledby={titleId} className="animate-hb-in">
      <EmptyHeader>
        <EmptyMedia>
          <ChiefMark mood="idle" size={56} />
        </EmptyMedia>
        <EmptyTitle asChild>
          <h1 id={titleId}>{title}</h1>
        </EmptyTitle>
        <EmptyDescription>{copy.body[failureOf(error)]}</EmptyDescription>
      </EmptyHeader>
      <Recovery error={error} way={way} />
    </Empty>
  );
}

/** A page that failed inside the app, with the sidebar still there to go elsewhere (STD-REACT-014). */
export function PageError({ error, way }: RouteErrorProps) {
  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <ErrorBody title={copy.pageTitle} error={error} way={way} />
    </main>
  );
}

/** A screen outside the sidebar that failed, such as a setup step or the sidebar itself. */
export function ScreenError({ error, way }: RouteErrorProps) {
  return (
    <main className="flex min-h-0 flex-1 flex-col bg-ground">
      <ErrorBody title={copy.pageTitle} error={error} way={way} />
    </main>
  );
}

/** The window itself failed: its title bar, Try again and Reload Hobbots, since no page around it may work. */
export function AppError({ error }: ErrorComponentProps) {
  return (
    <WindowFrame>
      <main className="flex min-h-0 flex-1 flex-col bg-ground">
        <ErrorBody title={copy.appTitle} error={error} />
      </main>
    </WindowFrame>
  );
}
