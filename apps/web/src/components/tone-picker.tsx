import { REPLY_LENGTHS, type ReplyLength, VOICE_GROUPS, VOICES, type Voice, voiceChoice } from "@hobbots/domain";
import { Choice } from "./hob-form.tsx";

/**
 * How a hob talks: one voice, in the picker's three groups, and one length. Each choice shows its
 * one-line description; themed voices sit under their own heading, marked as wording only.
 */
export function TonePicker({
  name,
  voice,
  length,
  onVoice,
  onLength,
}: {
  name: string;
  voice: Voice;
  length: ReplyLength;
  onVoice: (voice: Voice) => void;
  onLength: (length: ReplyLength) => void;
}) {
  return (
    <>
      <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
        <legend className="mb-2.5 font-bold">Voice</legend>
        {VOICE_GROUPS.map((group) => (
          <fieldset key={group.id} className="m-0 flex flex-col gap-1.5 border-0 p-0">
            <legend className="mb-1.5 flex items-center gap-2.5 text-[13px] font-bold text-secondary-text">
              {group.title}
              {group.id === "themed" && (
                <span className="bg-deep px-2 py-0.5 text-xs font-normal text-label">Changes wording only</span>
              )}
            </legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              {VOICES.filter((v) => v.group === group.id).map((v) => (
                <Choice
                  key={v.id}
                  name="hob-voice"
                  checked={v.id === voice}
                  onPick={() => onVoice(v.id)}
                  className="min-h-11 flex-col items-start gap-0.5 px-2.5"
                >
                  <span className="font-bold">{v.title}</span>
                  <span className="text-xs opacity-85">{v.description}</span>
                </Choice>
              ))}
            </div>
          </fieldset>
        ))}
        {voiceChoice(voice).group === "themed" && (
          <span className="text-[13px] text-label">
            Facts stay as accurate as ever. Code, commands, links and warnings stay plain, and {name} drops the voice
            when things get serious.
          </span>
        )}
      </fieldset>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2 font-bold">Length</legend>
        <div className="flex flex-wrap gap-2">
          {REPLY_LENGTHS.map((l) => (
            <Choice
              key={l.id}
              name="hob-length"
              checked={l.id === length}
              onPick={() => onLength(l.id)}
              className="min-h-11 min-w-[150px] flex-col items-start gap-0.5 px-2.5"
            >
              <span className="font-bold">{l.title}</span>
              <span className="text-xs opacity-85">{l.description}</span>
            </Choice>
          ))}
        </div>
      </fieldset>
    </>
  );
}
