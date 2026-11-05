import type { Question } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { formatList } from "../../lib/format.ts";
import { messages } from "./messages.ts";

const copy = messages.question;

/** How a question's choices show: full rows with what each does, or chips where space is short. */
export type ChoicesLook = "rows" | "chips";

/**
 * A question's choices as buttons (#740), in the order the hob gave them, the recommended one
 * marked, then the line that leads to the answer box. Clicking one answers with its label at once;
 * the box stays for anything else.
 */
export function QuestionChoices({
  question,
  askerName,
  look,
  disabled,
  onPick,
}: {
  question: Question;
  askerName: string;
  look: ChoicesLook;
  disabled: boolean;
  onPick: (label: string) => void;
}) {
  return (
    <>
      <ChoiceList question={question} askerName={askerName} look={look} disabled={disabled} onPick={onPick} />
      <span className="flex items-center gap-2 text-meta text-label before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
        {copy.orInWords}
      </span>
    </>
  );
}

function ChoiceList({
  question,
  askerName,
  look,
  disabled,
  onPick,
}: {
  question: Question;
  askerName: string;
  look: ChoicesLook;
  disabled: boolean;
  onPick: (label: string) => void;
}) {
  return (
    <ul
      aria-label={copy.choices({ name: askerName })}
      className={
        look === "rows" ? "m-0 flex list-none flex-col gap-1.5 p-0" : "m-0 flex list-none flex-wrap gap-1.5 p-0"
      }
    >
      {question.options.map((option, index) => {
        const recommended = index === question.recommended;
        const key = String(index + 1);
        return (
          <li key={option.label} className={look === "rows" ? "flex" : undefined}>
            <Button
              type="button"
              variant={look === "rows" ? "choice" : "chip"}
              size={look === "rows" ? "default" : "xs"}
              className={look === "rows" ? "w-full" : undefined}
              data-recommended={recommended}
              aria-keyshortcuts={key}
              title={look === "chips" && option.consequence !== "" ? option.consequence : undefined}
              disabled={disabled}
              onClick={() => onPick(option.label)}
            >
              <kbd
                aria-hidden
                className="min-w-4.5 rounded-tag border border-b-(length:--edge) border-line-2 bg-card px-1 text-center font-sans text-meta text-text-secondary"
              >
                {key}
              </kbd>
              {look === "rows" ? (
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2 font-bold">
                    {option.label}
                    {recommended && <Recommended />}
                  </span>
                  {option.consequence !== "" && (
                    <span className="text-detail text-text-secondary">{option.consequence}</span>
                  )}
                </span>
              ) : (
                <>
                  {option.label}
                  {recommended && (
                    <span className="text-mint">
                      <span aria-hidden>{copy.recommendedMark}</span>
                      <span className="sr-only">{copy.recommendedSaid}</span>
                    </span>
                  )}
                  {option.consequence !== "" && (
                    <span className="sr-only">{copy.consequenceSaid({ consequence: option.consequence })}</span>
                  )}
                </>
              )}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function Recommended() {
  return (
    <span className="rounded-tag bg-[color-mix(in_srgb,var(--color-mint)_16%,transparent)] px-1.5 text-meta font-bold text-mint">
      <span aria-hidden className="me-1">
        {copy.recommendedMark}
      </span>
      {copy.recommended}
    </span>
  );
}

/**
 * An answered question's choices, under your answer on its card: what the one you picked does, and
 * what else was offered; for an answer in words, that it was none of them.
 */
export function AnsweredChoices({ question }: { question: Question }) {
  if (question.options.length === 0) return null;
  const picked = question.picked === null ? undefined : question.options[question.picked];
  const others = question.options.filter((_, index) => index !== question.picked).map((option) => option.label);
  return (
    <span className="flex flex-col gap-0.5 text-detail text-text-secondary">
      {picked === undefined ? (
        <span>{copy.inYourWords}</span>
      ) : (
        picked.consequence !== "" && <span>{picked.consequence}</span>
      )}
      <span className="text-label">
        {(picked === undefined ? copy.offered : copy.alsoOffered)({ labels: formatList(others) })}
      </span>
    </span>
  );
}
