/** Words for a message the hub would not take, in place of the raw API error. */
export const sendErrorText = (
  error: { readonly message: string; readonly tag?: string | undefined },
  hob: { readonly name: string; readonly status: string },
): string => {
  switch (error.tag) {
    case "HobUnavailable":
      return hob.status === "paused"
        ? `${hob.name} is paused, so this message was not sent. Wake ${hob.name}, then send it again.`
        : `${hob.name} cannot take new work right now, so this message was not sent.`;
    case "ThreadBusy":
      return `${hob.name} is still replying in this thread. Wait for the reply or stop it, then send again.`;
    case "ThreadNotFound":
      return "This thread is no longer on the hub, so the message was not sent. Start a new thread.";
    default:
      return error.message.trim() === ""
        ? "Could not send. Check that Hobbots is running, then try again."
        : `Could not send: ${error.message}`;
  }
};
