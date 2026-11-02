/** User-facing copy for the desktop app's main process, grouped by feature (STD-I18N-001). */
export const messages = {
  requestNotice: {
    title: ({ name }: { name: string }) => `${name} asks permission`,
    unknownHob: "A hob",
  },
  remoteAccess: {
    pause: "Pause remote access",
    pauseHint: "Your other devices can open Hobbots",
    resume: "Resume remote access",
    resumeHint: "Paused · only this computer can open Hobbots",
    couldNotPause: "Hobbots could not pause remote access",
    couldNotResume: "Hobbots could not resume remote access",
    checkServer: "Check that the server is running, then try again.",
    ok: "OK",
  },
} as const;
