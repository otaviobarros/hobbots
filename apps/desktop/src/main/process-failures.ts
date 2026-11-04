/**
 * Logs what fails in the main process outside any handler (STD-DESKTOP-010): an uncaught exception
 * or a rejected promise nobody awaited. Electron would otherwise show a raw error dialog or say nothing.
 */
export const logProcessFailures = (
  process: Pick<NodeJS.Process, "on">,
  log: (message: string, error: unknown) => void = (message, error) => console.error(message, error),
) => {
  process.on("uncaughtException", (error) => log("Hobbots hit an error it did not expect", error));
  process.on("unhandledRejection", (reason) => log("A Hobbots task failed with nobody waiting for it", reason));
};
