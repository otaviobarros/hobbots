/** A Quest's chip on a chat row or a History event: a flag and the goal, cut short with the whole of it on hover. */
export function QuestChip({ label }: { label: string }) {
  return (
    <span
      title={label}
      className="inline-flex h-[22px] max-w-full min-w-0 items-center gap-1 rounded-tag bg-[color-mix(in_srgb,var(--color-star)_16%,transparent)] px-2 text-meta leading-[22px] font-semibold whitespace-nowrap text-star"
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="size-3 shrink-0"
      >
        <path d="M3.5 14V2.5M3.5 3h8l-2 3 2 3h-8" />
      </svg>
      <span className="truncate">{label}</span>
    </span>
  );
}
