import { AgentId, type ApprovalSurface, CODING_SETUP_KIND, type HubQuestion } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { codingSetupQuery, useClearCodingSetup } from "../../api/github.ts";
import { useHobDirectory } from "../../lib/use-hob-directory.ts";
import type { FocusTargets } from "../move-on/follow-focus.ts";
import { HubAnswerForm } from "../quest/answer-form.tsx";
import { messages } from "./messages.ts";

const copy = messages;

/** Whether a hub question asks if a hob will write code (#1241). */
export const isCodingSetup = (question: HubQuestion) => question.subject.kind === CODING_SETUP_KIND;

/**
 * The card's actions (#1241): Set up GitHub opens the hob's Charms tab, where its GitHub section
 * is, and leaves the card open; its choices stop the card for this hob or for every hob. There is
 * no answer box: there is nothing to type.
 */
export function CodingSetupActions({
  question,
  askerName,
  via,
  targets,
}: {
  question: HubQuestion;
  askerName: string;
  via: ApprovalSurface;
  targets?: FocusTargets;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Button asChild className="self-start">
        <Link
          to="/hobs/$hobId/profile"
          params={{ hobId: AgentId.make(question.subject.key) }}
          search={{ tab: "charms" }}
        >
          {copy.setUp}
        </Link>
      </Button>
      <HubAnswerForm
        question={question}
        askerName={askerName}
        via={via}
        inWords={false}
        {...(targets === undefined ? {} : { targets })}
      />
    </div>
  );
}

/** Settings › Charms › GitHub: where you turned the card off, and a button that shows it again. */
export function CodingSetupSetting() {
  const choices = useQuery(codingSetupQuery);
  const clear = useClearCodingSetup();
  const { hobs } = useHobDirectory();
  const said = choices.data;
  const off = said !== undefined && (said.allHobs || said.hobs.length > 0);
  const names = (said?.hobs ?? []).map((id) => hobs.get(id)?.name ?? copy.setting.unknownHob);
  return (
    <div className="flex flex-col gap-1.5 border-b-(length:--edge) border-line py-2.5">
      <span className="font-bold">{copy.setting.name}</span>
      <span className="text-ui text-text-secondary">{copy.setting.asks}</span>
      {choices.isError && (
        <p role="alert" className="m-0 text-ui text-rose">
          {copy.setting.failed}
        </p>
      )}
      {off && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-ui text-text">
            {said.allHobs ? copy.setting.allHobs : copy.setting.someHobs({ names })}
          </span>
          <Button variant="outline" size="xs" disabled={clear.isPending} onClick={() => clear.mutate()}>
            {copy.setting.showAgain}
          </Button>
        </div>
      )}
      {clear.isError && (
        <p role="alert" className="m-0 text-ui text-rose">
          {copy.setting.clearFailed}
        </p>
      )}
    </div>
  );
}
