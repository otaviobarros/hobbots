import { createContext, useContext } from "react";

/**
 * Whether the chat is in view: true, except while it is folded away beside the Quest room (ADR 027),
 * where it stays mounted out of sight. A chat out of view does not count its replies read.
 */
export const ChatInView = createContext(true);

export const useChatInView = (): boolean => useContext(ChatInView);
