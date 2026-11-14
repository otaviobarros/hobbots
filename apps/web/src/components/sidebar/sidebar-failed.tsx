import { messages as copy } from "./messages.ts";

/**
 * A section that could not be read says so, with Try again, so a missing camp or hob is not taken for
 * none. On the rail the words are read out and the button keeps them as its name.
 */
export function SidebarFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex w-full flex-none items-center justify-center gap-2 px-2.5 py-1 text-detail">
      <span className="flex-1 text-rose max-wide:sr-only">{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex cursor-pointer items-center justify-center rounded-control border-0 bg-transparent px-1.5 py-0.5 text-detail font-semibold text-text-strong hover:bg-hover"
      >
        <span className="max-wide:sr-only">{copy.tryAgain}</span>
        <span aria-hidden className="wide:hidden">
          {copy.retryMark}
        </span>
      </button>
    </div>
  );
}
