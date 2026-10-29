import { Button } from "@hobbots/ui/components/button";
import { useNavigate } from "@tanstack/react-router";
import { useUpdateSetup } from "../api/setup.ts";
import { Stars } from "./scene.tsx";

/**
 * Welcome, the first screen of a new installation. A placeholder until the full screen and the
 * setup steps arrive: "I already use Hobbots" skips setup and opens Home.
 */
export function Welcome() {
  const navigate = useNavigate();
  const update = useUpdateSetup();

  const skipSetup = () => update.mutate({ completed: true }, { onSuccess: () => navigate({ to: "/" }) });

  return (
    <main className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-5 overflow-hidden bg-panel px-9">
      <Stars count={40} height={420} />
      <h1 className="relative m-0 font-pixel text-[40px] font-bold text-moonlight">Welcome to Hobbots</h1>
      <p className="relative m-0 max-w-[460px] text-center text-[17px] leading-normal">
        Hobs are AI helpers that work on this computer, alone or together. Setting up your first one takes a few
        minutes.
      </p>
      <div className="relative flex flex-col items-center gap-3">
        <Button disabled aria-describedby="welcome-setup-note">
          Get started
        </Button>
        <span id="welcome-setup-note" className="text-sm text-label">
          Guided setup is on its way.
        </span>
        <Button variant="outline" onClick={skipSetup} disabled={update.isPending}>
          I already use Hobbots
        </Button>
        {update.isError && (
          <span role="alert" className="text-sm text-rose">
            Hobbots could not save that. Try again in a moment.
          </span>
        )}
      </div>
    </main>
  );
}
