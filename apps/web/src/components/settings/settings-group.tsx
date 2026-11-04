import { cn } from "@hobbots/ui/lib/utils";

/** One group of a Settings section: its label, then its settings. */
export function SettingsGroup({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section aria-label={label} className={cn("flex flex-col gap-3", className)}>
      <h3 className="lbl m-0 text-label">{label}</h3>
      {children}
    </section>
  );
}
