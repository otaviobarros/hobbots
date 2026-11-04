import { Button } from "@hobbots/ui/components/button";
import { Dialog, DialogContent, DialogTitle } from "@hobbots/ui/components/dialog";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useUpdateSetup, watchedSetupQuery } from "../api/setup.ts";
import { messages as backupMessages } from "./backup/messages.ts";
import { RestoreFlow } from "./backup/restore-flow.tsx";
import { messages } from "./messages.ts";
import { WelcomeVillage, welcomeActionClass } from "./welcome-village.tsx";

const copy = messages.welcome;

/**
 * Welcome on the hub's own pages: Get started into setup, "I already use Hobbots" to skip it and
 * open Home, and Restore a backup before setup (ADR 026).
 */
export function Welcome() {
  const navigate = useNavigate();
  const update = useUpdateSetup();
  // Setup may finish in another window or on another device; Home opens once it has.
  const setup = useQuery(watchedSetupQuery);
  const completedElsewhere = setup.data?.completed === true;
  useEffect(() => {
    if (completedElsewhere) void navigate({ to: "/" });
  }, [completedElsewhere, navigate]);

  const [restoring, setRestoring] = useState(false);

  const skipSetup = () => update.mutate({ completed: true }, { onSuccess: () => navigate({ to: "/" }) });

  return (
    <>
      <WelcomeVillage
        alert={update.isError ? copy.saveFailed : undefined}
        actions={
          <>
            <Button asChild className={welcomeActionClass.primary}>
              <Link to="/setup/where">{copy.getStarted}</Link>
            </Button>
            <Button
              variant="ghost"
              onClick={skipSetup}
              disabled={update.isPending}
              className={welcomeActionClass.secondary}
            >
              {copy.alreadyUse}
            </Button>
          </>
        }
        more={
          <Button variant="link" onClick={() => setRestoring(true)} className="bg-ground/60 px-2 text-sm">
            {backupMessages.welcome.open}
          </Button>
        }
      />
      <Dialog open={restoring} onOpenChange={setRestoring}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle className="m-0 font-heading text-2xl font-bold text-moonlight">
            {backupMessages.restore.title}
          </DialogTitle>
          <RestoreFlow onCancel={() => setRestoring(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}
