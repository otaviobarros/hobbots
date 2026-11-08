import type { Question } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { formatList } from "../../lib/format.ts";
import { Said } from "../said/said.tsx";
import { messages } from "./messages.ts";

const copy = messages.question;

/** What the buttons read from a question, a hob's or the hub's own (#976). */
type Choices = Pick<Question, "options" | "recommended">;

/** How a question's choices show: full rows with what each does, or chips where space is short. */
export type ChoicesLook = "rows" | "chips";

/**
 * A question's choices as buttons (#740), in the order the hob gave them, the recommended one
 * marked, then the line that leads to the answer box. Clicking one answers with it at once, its
 * label and its place in the list; the box stays for anything else.
 */
/** What the choices show and do; `onPick` gets the choice's label and its place in the list. */
interface ChoicesProps {
  question: Choices;
  askerName: string;
  look: ChoicesLook;
  disabled: boolean;
  onPick: (label: string, index: number) => void;
  /** Whether an answer box follows, which the line below the choices leads to. */
  inWords?: boolean;
}

export function QuestionChoices({ question, askerName, look, disabled, onPick, inWords = true }: ChoicesProps) {
  const list = <ChoiceList question={question} askerName={askerName} look={look} disabled={disabled} onPick={onPick} />;
  if (!inWords) return list;
  return (
    <>
      {list}
      <span className="flex items-center gap-2 text-meta text-label before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
        {copy.orInWords}
      </span>
    </>
  );
}

function ChoiceList({ question, askerName, look, disabled, onPick }: ChoicesProps) {
  return (
    <ul
      aria-label={copy.choices({ name: askerName })}
      className={cn("m-0 flex list-none gap-1.5 p-0", look === "rows" ? "flex-col" : "flex-wrap")}
    >
      {question.options.map((option, index) => {
        const recommended = index === question.recommended;
        const key = String(index + 1);
        return (
          <li key={option.label} className={cn(look === "rows" && "flex")}>
            <Button
              type="button"
              variant={look === "rows" ? "choice" : "chip"}
              size={look === "rows" ? "default" : "xs"}
              className={cn(look === "rows" && "w-full")}
              data-recommended={recommended}
              aria-keyshortcuts={key}
              title={look === "chips" && option.consequence !== "" ? option.consequence : undefined}
              disabled={disabled}
              onClick={() => onPick(option.label, index)}
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
                  {/* A chip shows only its label, so its name says the rest after it (#740, WCAG 2.5.3). */}
                  <span>
                    {option.label}
                    <ChipSaid recommended={recommended} consequence={option.consequence} />
                  </span>
                  {recommended && (
                    <span aria-hidden className="text-mint">
                      {copy.recommendedMark}
                    </span>
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

/** What a chip's name says after the label it shows: whether it is recommended and what it does. */
function ChipSaid({ recommended, consequence }: { recommended: boolean; consequence: string }) {
  const said = copy.chipSaid({ recommended, consequence });
  return said === "" ? null : <Said>{said}</Said>;
}

function Recommended() {
  return (
    <span className="rounded-tag bg-[color-mix(in_srgb,var(--color-mint)_12%,transparent)] px-1.5 text-meta font-bold text-mint">
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
export function AnsweredChoices({ question }: { question: Pick<Question, "options" | "picked"> }) {
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
