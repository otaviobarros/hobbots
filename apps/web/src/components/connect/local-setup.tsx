import type { AddressRefusal, ConnectEnd, WaitingView } from "@hobbots/api";
import { Button } from "@hobbots/ui/components/button";
import { useEffect, useRef, useState } from "react";
import { messages as appMessages } from "../messages.ts";
import { WelcomeVillage, welcomeActionClass } from "../welcome-village.tsx";
import { ConnectChoice, choiceOpenClass, RunHereChoice, WhereLayout } from "../where-hobbots-runs.tsx";
import { endedSpeech, type SetupBridge } from "./connect-model.ts";
import { ConnectAllowed, ConnectEnded, ConnectForm, ConnectWaiting } from "./connect-screens.tsx";

const where = appMessages.where;
const welcome = appMessages.welcome;

/** Where setup's local pages stand. */
type Screen =
  | { readonly name: "welcome" }
  | { readonly name: "where"; readonly starting: boolean; readonly failed: boolean }
  | {
      readonly name: "connect";
      readonly address: string;
      readonly busy: boolean;
      readonly refusal?: AddressRefusal | undefined;
    }
  | { readonly name: "waiting"; readonly address: string; readonly waiting: WaitingView }
  | { readonly name: "ended"; readonly address: string; readonly end: Extract<ConnectEnd, { kind: "ended" }> }
  | { readonly name: "allowed"; readonly computer: string };

/** The screen a connect that finished leads to. */
const afterConnect = (address: string, end: ConnectEnd): Screen => {
  switch (end.kind) {
    case "allowed":
      return { name: "allowed", computer: end.computer };
    case "cancelled":
      return { name: "connect", address, busy: false };
    case "refused":
      return { name: "connect", address, busy: false, refusal: end.refusal };
    case "ended":
      return { name: "ended", address, end };
  }
};

/** Run here and Connect, the two choices of Where Hobbots runs, on a computer that is not a hub yet. */
function WhereChoices({
  starting,
  failed,
  onRunHere,
  onConnect,
}: {
  starting: boolean;
  failed: boolean;
  onRunHere: () => void;
  onConnect: () => void;
}) {
  return (
    <WhereLayout
      footer={
        failed && (
          <p role="alert" className="m-0 pt-3 text-sm text-rose">
            {where.startFailed}
          </p>
        )
      }
    >
      <button type="button" className={choiceOpenClass} disabled={starting} onClick={onRunHere}>
        <RunHereChoice badge={starting ? where.starting : where.here.badge} />
      </button>
      <button type="button" className={choiceOpenClass} disabled={starting} onClick={onConnect}>
        <ConnectChoice />
      </button>
    </WhereLayout>
  );
}

/**
 * Setup's local pages in the desktop app (ADR 025): Welcome and Where Hobbots runs on a computer that
 * is neither a hub nor connected to one, so no server runs yet. Run here starts this computer's hub,
 * whose window continues setup. Connect finds or takes the hub's address, waits with the matching
 * code, and once the hub allows it the hub's own pages open on Home.
 */
export function LocalSetup({ bridge, start = "welcome" }: { bridge: SetupBridge; start?: "welcome" | "where" }) {
  const [screen, setScreen] = useState<Screen>(() =>
    start === "where" ? { name: "where", starting: false, failed: false } : { name: "welcome" },
  );

  // The hub's prompt is up: show its code, unless the user moved on meanwhile.
  useEffect(
    () =>
      bridge.onWaiting((waiting) =>
        setScreen((now) =>
          now.name === "connect" && now.busy ? { name: "waiting", address: now.address, waiting } : now,
        ),
      ),
    [bridge],
  );

  // Each Connect is one attempt; leaving Connect or starting another makes the earlier one's answer stale.
  const attempt = useRef(0);

  const connect = async (address: string) => {
    const mine = ++attempt.current;
    setScreen({ name: "connect", address, busy: true });
    let end: ConnectEnd;
    try {
      end = await bridge.connect(address);
    } catch {
      end = { kind: "ended", computer: address, address, outcome: { kind: "noAnswer" } };
    }
    if (attempt.current === mine) setScreen(afterConnect(address, end));
  };

  /** Back from Connect stops a request still under way, so nothing it answers later can connect. */
  const leaveConnect = () => {
    attempt.current++;
    void bridge.cancel();
    setScreen({ name: "where", starting: false, failed: false });
  };

  const runHere = async () => {
    setScreen({ name: "where", starting: true, failed: false });
    try {
      // The hub's own window takes over once its server answers.
      await bridge.runHere();
    } catch {
      setScreen({ name: "where", starting: false, failed: true });
    }
  };

  const toConnect = (address = "") => setScreen({ name: "connect", address, busy: false });

  switch (screen.name) {
    case "welcome":
      return (
        <WelcomeVillage
          actions={
            <>
              <Button
                className={welcomeActionClass.primary}
                onClick={() => setScreen({ name: "where", starting: false, failed: false })}
              >
                {welcome.getStarted}
              </Button>
              {/* Someone who already uses Hobbots has a hub elsewhere: this computer connects to it. */}
              <Button variant="ghost" className={welcomeActionClass.secondary} onClick={() => toConnect()}>
                {welcome.alreadyUse}
              </Button>
            </>
          }
        />
      );
    case "where":
      return (
        <WhereChoices
          starting={screen.starting}
          failed={screen.failed}
          onRunHere={() => void runHere()}
          onConnect={() => toConnect()}
        />
      );
    case "connect":
      return (
        <ConnectForm
          bridge={bridge}
          address={screen.address}
          refusal={screen.refusal}
          busy={screen.busy}
          onAddress={(address) =>
            setScreen((now) => (now.name === "connect" ? { ...now, address, refusal: undefined } : now))
          }
          onConnect={(address) => void connect(address)}
          onBack={leaveConnect}
        />
      );
    case "waiting":
      return <ConnectWaiting waiting={screen.waiting} onCancel={() => void bridge.cancel()} />;
    case "ended":
      return (
        <ConnectEnded
          end={screen.end}
          speech={endedSpeech(screen.end)}
          onAskAgain={() => void connect(screen.address)}
          onBack={() => toConnect(screen.address)}
        />
      );
    case "allowed":
      return <ConnectAllowed computer={screen.computer} />;
  }
}
