import type { Agent, Message } from "@hobbots/domain";
import { formatTime } from "../lib/time.ts";
import { HobSprite } from "./hob-sprite.tsx";

export function MessageRow({ message, hob }: { message: Message; hob: Agent }) {
  if (message.role === "user") {
    return (
      <div className="max-w-[460px] animate-hb-in self-end bg-line px-3.5 py-2.5 leading-[1.45] whitespace-pre-wrap">
        {message.content}
      </div>
    );
  }

  const streaming = message.status === "streaming";
  return (
    <div className="flex max-w-[640px] animate-hb-in gap-2.5">
      <HobSprite hob={hob} size={26} state={streaming ? "working" : message.status === "failed" ? "failed" : "idle"} />
      <div className="flex min-w-0 flex-col gap-[3px]">
        <span className="text-xs text-label">
          <b className="font-pixel text-sm text-moonlight">{hob.name}</b> {formatTime(message.createdAt)}
        </span>
        {streaming && message.content.length === 0 ? (
          <Thinking name={hob.name} />
        ) : (
          <span className="leading-normal whitespace-pre-wrap">
            {message.content}
            {streaming && (
              <span aria-hidden className="ml-0.5 inline-block h-4 w-2 animate-hb-caret bg-moonlight align-[-2px]" />
            )}
          </span>
        )}
        {message.status === "interrupted" && (
          <span className="animate-hb-pop origin-left text-[13px] text-lantern">
            ■ This reply was stopped. {hob.name} kept what it wrote so far.
          </span>
        )}
        {message.status === "failed" && (
          <span className="animate-hb-pop origin-left text-[13px] text-rose">
            ✗ This reply failed: {message.error ?? "unknown error"}. Send your message again to retry.
          </span>
        )}
      </div>
    </div>
  );
}

function Thinking({ name }: { name: string }) {
  return (
    <span role="status" className="flex items-center gap-2.5 text-sm text-secondary-text">
      {name} is thinking
      <span aria-hidden className="flex gap-1">
        <span className="size-[5px] animate-hb-blink bg-mint" />
        <span className="size-[5px] animate-hb-blink bg-mint [animation-delay:.3s]" />
        <span className="size-[5px] animate-hb-blink bg-mint [animation-delay:.6s]" />
      </span>
    </span>
  );
}
