import { Button } from "@hobbots/ui/components/button";
import { QrCode } from "@hobbots/ui/components/qr-code";
import type { ReactNode } from "react";
import { useCopy } from "../../lib/use-copy.ts";
import { messages } from "../messages.ts";

const copy = messages.remoteAccess;

/**
 * The address other devices open, with Copy, and its QR code to scan from a phone (ADR 021). Setup
 * and Settings › Devices show it alike; `children` carries what each says under it.
 */
export function RemoteAddress({ address, label, children }: { address: string; label: string; children?: ReactNode }) {
  const [copied, copyText] = useCopy();
  return (
    <div className="flex flex-wrap items-start gap-5">
      <div className="flex min-w-[260px] flex-1 flex-col gap-2">
        <span className="lbl text-meta text-label">{label}</span>
        <div className="cut flex items-center gap-2.5 border-(length:--edge) border-control bg-deep px-3 py-2">
          <span className="min-w-0 flex-1 font-mono text-reading font-bold text-moonlight wrap-anywhere">
            {address}
          </span>
          <Button variant="outline" size="xs" onClick={() => copyText(address)}>
            {copied === "idle" ? copy.copy : copied === "copied" ? copy.copied : copy.copyFailed}
          </Button>
          <span aria-live="polite" className="sr-only">
            {copied === "copied" ? copy.copied : copied === "failed" ? copy.copyFailed : ""}
          </span>
        </div>
        {children}
      </div>
      <figure className="cut m-0 flex flex-none flex-col items-center gap-1.5 bg-text-strong p-2.5 text-ground">
        <QrCode value={address} label={copy.qrLabel({ address })} size={116} />
        <figcaption className="text-meta font-bold">{copy.scan}</figcaption>
      </figure>
    </div>
  );
}
