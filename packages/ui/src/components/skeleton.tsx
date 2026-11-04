import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../lib/utils.ts";
import type { Wait } from "../lib/wait-stage.ts";
import { Button } from "./button.tsx";

// A still block that holds the place of a value while it loads, so nothing moves when the value
// arrives (Patterns › Loading in the design system). It never shimmers or pulses, in any theme, so
// it needs no Reduce motion exception (STD-UI-004).
const skeletonVariants = cva("shrink-0 rounded-tag", {
  variants: {
    shape: {
      // One line of the type style around it: the block fills 60% of the line height, centred.
      // The outer span takes the line, the inner one draws the block.
      text: "inline-flex h-lh items-center align-top",
      // A status tag: the detail line and the tag's padding, as Badge has them.
      block: "box-content inline-block h-lh py-0.5 align-middle text-detail",
      // A hob or provider tile. Its size comes from the caller, such as size-10.
      tile: "block rounded-tile",
      // A meter's empty track, the same as Progress before it fills: line-2 on every surface.
      bar: "block w-full rounded-dot",
    },
    // The fill: line on ground and panel, line-2 on card, where line would not show.
    surface: {
      plain: "bg-line",
      card: "bg-line-2",
    },
    size: {
      default: "",
      sm: "",
    },
  },
  compoundVariants: [
    // The text shape draws its block on the inner span, so the outer one has no fill.
    { shape: "text", className: "bg-transparent" },
    { shape: "bar", className: "bg-line-2" },
    { shape: "bar", size: "default", className: "h-2.5" },
    { shape: "bar", size: "sm", className: "h-1.5" },
  ],
  defaultVariants: {
    shape: "text",
    surface: "plain",
    size: "default",
  },
});

const textFillVariants = cva("block h-3/5 w-full rounded-tag", {
  variants: {
    surface: {
      plain: "bg-line",
      card: "bg-line-2",
    },
  },
  defaultVariants: {
    surface: "plain",
  },
});

/**
 * Holds the place of a value that is still loading. Give `text` and `block` the value's likely
 * length as `width`, such as `12ch`, so the line does not move when the value lands. A `tile` or a
 * `bar` takes its size from the layout. The block is hidden from assistive technology: the region
 * around it carries `aria-busy` while it loads.
 */
function Skeleton({
  className,
  shape = "text",
  surface = "plain",
  size = "default",
  width,
  ...props
}: Omit<React.ComponentProps<"span">, "children"> &
  VariantProps<typeof skeletonVariants> & {
    /** The likely length of the value, as a CSS length such as `12ch`. */
    width?: string;
  }) {
  return (
    <span
      data-slot="skeleton"
      data-shape={shape}
      aria-hidden="true"
      className={cn(skeletonVariants({ shape, surface, size }), className)}
      style={width === undefined ? undefined : { inlineSize: width }}
      {...props}
    >
      {shape === "text" ? <span data-slot="skeleton-fill" className={textFillVariants({ surface })} /> : null}
    </span>
  );
}

/** What an outside call says once it has waited 10 seconds, and how to ask again. */
interface WaitNoteOutside {
  /** A plain sentence on what the wait means, such as "Claude Code is slow to answer. Your hobs keep working." */
  readonly note: string;
  /** The label of the quiet retry button, "Try again", from the caller's messages (STD-I18N-001). */
  readonly retryLabel: string;
  /** Asks again, such as a query's `refetch`. The wait line's clock starts again too. */
  readonly onRetry: () => void;
}

/**
 * The region's wait line. It shows nothing for the first second, so a fast read flashes no text.
 * After 1 second it names what the region is waiting on, in a polite status that is announced
 * once. After 10 seconds, for a call outside the hub (`outside`), it adds a plain sentence and Try
 * again. Reads from the hub leave `outside` out, since they are quick. Pass the region's clock from
 * `useWaitStage`, so the screen and its wait line share one timer.
 */
function WaitNote({
  className,
  wait,
  detail,
  outside,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  wait: Wait;
  /** Names what the region waits on, such as "Asking Claude Code for your plan…". */
  detail: string;
  outside?: WaitNoteOutside;
}) {
  const stuck = wait.stage === "stuck" && outside !== undefined;
  const retry = () => {
    wait.restart();
    outside?.onRetry();
  };

  return (
    <div
      data-slot="wait-note"
      data-stage={wait.stage}
      className={cn("flex min-w-0 flex-wrap items-center gap-x-2 text-detail text-text-secondary", className)}
      {...props}
    >
      {/* The status stays mounted from the start, so its one line is announced when it appears. */}
      <p role="status" className="m-0">
        {wait.stage === "none" ? null : detail}
      </p>
      {stuck ? (
        <>
          <p className="m-0">{outside.note}</p>
          <Button variant="ghost" size="xs" onClick={retry}>
            {outside.retryLabel}
          </Button>
        </>
      ) : null}
    </div>
  );
}

export { Skeleton, WaitNote, type WaitNoteOutside };
