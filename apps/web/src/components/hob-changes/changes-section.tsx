import { useId } from "react";
import { ChangesLog } from "./changes-log.tsx";
import type { ChangesSearch } from "./hob-changes-model.ts";
import { messages } from "./messages.ts";
import { SettingHistory } from "./setting-history.tsx";

/**
 * Settings › Changes: the changes to the hub settings that decide what every hob may do (#1357),
 * then every change to every hob (ADR 034).
 */
export function ChangesSection({ search }: { search: ChangesSearch }) {
  const hobsHeading = useId();
  return (
    <div className="flex flex-col gap-6">
      <SettingHistory />
      <section aria-labelledby={hobsHeading} className="flex flex-col gap-3">
        <h3 id={hobsHeading} className="m-0 text-ui font-semibold text-text-strong">
          {messages.settings.hobsHeading}
        </h3>
        <ChangesLog search={search} />
      </section>
    </div>
  );
}
