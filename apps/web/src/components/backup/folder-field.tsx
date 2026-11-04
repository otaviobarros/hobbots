import { Button } from "@hobbots/ui/components/button";
import { useId, useState } from "react";

const chooseBackupFolder = globalThis.window?.hobbots?.chooseBackupFolder;

/**
 * A folder on the hub, typed or, in the desktop app, picked in the system dialog. The hub checks
 * whatever it is given again.
 */
export function FolderField({
  label,
  hint,
  chooseLabel,
  purpose,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  chooseLabel: string;
  purpose: "save" | "restore";
  value: string;
  onChange: (folder: string) => void;
  disabled: boolean;
}) {
  const inputId = useId();
  const hintId = useId();
  const [picking, setPicking] = useState(false);
  const pick = async () => {
    if (!chooseBackupFolder || picking) return;
    setPicking(true);
    try {
      const folder = await chooseBackupFolder(purpose);
      if (folder) onChange(folder);
    } finally {
      setPicking(false);
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-ui font-bold">
        {label}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          aria-describedby={hintId}
          value={value}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
          className="cut min-w-0 flex-1 basis-64 border-2 border-control bg-deep px-3 py-2 font-mono text-ui text-text-strong focus-ring disabled:opacity-60"
        />
        {chooseBackupFolder && (
          <Button variant="outline" disabled={disabled || picking} onClick={() => void pick()}>
            {chooseLabel}
          </Button>
        )}
      </div>
      <span id={hintId} className="text-detail text-text-secondary">
        {hint}
      </span>
    </div>
  );
}
