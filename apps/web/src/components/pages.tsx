import { Badge } from "@hobbots/ui/components/badge";
import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { cn } from "@hobbots/ui/lib/utils";
import { ICONS, type IconName, iconPalette } from "../art/icons.ts";
import { GeneralSettings } from "./general-settings.tsx";
import { RuntimeCard } from "./runtime.tsx";

function Page({
  icon,
  title,
  intro,
  children,
}: {
  icon: IconName;
  title: string;
  intro: string;
  children: React.ReactNode;
}) {
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-9 py-8">
      <header className="flex items-center gap-3.5">
        <PixelArt rows={ICONS[icon]} palette={iconPalette(true)} size={40} />
        <div className="flex flex-col gap-0.5">
          <h1 className="m-0 font-pixel text-[28px] font-bold text-moonlight">{title}</h1>
          <p className="m-0 text-secondary-text">{intro}</p>
        </div>
      </header>
      {children}
    </main>
  );
}

function Panel({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <section
      aria-label={label}
      className={cn("cut flex max-w-[760px] flex-col gap-3 bg-panel px-[18px] py-4", className)}
    >
      <span className="lbl text-moonlight">{label}</span>
      {children}
    </section>
  );
}

export function InboxPage() {
  return (
    <Page
      icon="Inbox"
      title="Inbox"
      intro="Questions, approvals, problems and results from every hob, grouped by Quest."
    >
      <Panel label="Needs you">
        <p className="m-0 text-secondary-text">
          Nothing needs you. Approvals arrive with the MVP: you will see the exact action, who asked, the risk, and pick
          how long your answer lasts (just this once, for this Quest, or always for this site).
        </p>
      </Panel>
    </Page>
  );
}

export function UsagePage() {
  return (
    <Page icon="Usage" title="Usage" intro="One potion per connected AI plan, and who used what.">
      <Panel label="AI plans">
        <p className="m-0 text-secondary-text">
          Subscription windows drain and refill, API keys show spend and local models are unlimited. Numbers appear here
          once each provider reports them.
        </p>
      </Panel>
    </Page>
  );
}

// Providers from the Hobbots design. Only Claude Code is wired in this build.
const LATER_PROVIDERS = [
  { name: "ChatGPT (Codex)", mark: "G", color: "#8fd3a8" },
  { name: "Gemini", mark: "G", color: "#8fb4f0" },
  { name: "Grok", mark: "X", color: "#c9c3e8" },
  { name: "Local models (Ollama)", mark: "L", color: "#f3e9b5" },
  { name: "Any OpenAI-compatible key", mark: "+", color: "#b79be8" },
];

export function SettingsPage() {
  return (
    <Page icon="Settings" title="Settings" intro="How Hobbots starts, AI providers, devices, backups and diagnostics.">
      <Panel label="General">
        <GeneralSettings />
      </Panel>
      <Panel label="AI providers">
        <RuntimeCard />
        <div className="flex flex-col">
          {LATER_PROVIDERS.map((p) => (
            <ProviderRow key={p.name} name={p.name} mark={p.mark} color={p.color}>
              <Badge variant="later">Later</Badge>
            </ProviderRow>
          ))}
        </div>
      </Panel>
    </Page>
  );
}

function ProviderRow({
  name,
  mark,
  color,
  children,
}: {
  name: string;
  mark: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3.5 border-b-2 border-line py-2.5">
      <span
        aria-hidden
        className="cut grid size-[30px] place-items-center font-bold text-ground"
        style={{ background: color }}
      >
        {mark}
      </span>
      <span className="flex-1">{name}</span>
      {children}
    </div>
  );
}
