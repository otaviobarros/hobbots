/** User-facing copy for the desktop app's main process, grouped by feature (STD-I18N-001). */
export const messages = {
  requestNotice: {
    title: ({ name }: { name: string }) => `${name} asks permission`,
    unknownHob: "A hob",
  },
  deviceNotice: {
    title: ({ name }: { name: string }) => `${name} wants to use Hobbots`,
    body: ({ code }: { code: string }) => `Check that it shows ${code}, then Allow or Deny.`,
  },
} as const;
