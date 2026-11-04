import { cn } from "@hobbots/ui/lib/utils";

/** The quest's flag, beside its name in the chat header and on its sheet. */
export function FlagIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden
      className={cn("shrink-0", className)}
    >
      <path d="M4 14V2.5M4 3h7.5l-1.5 3 1.5 3H4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
