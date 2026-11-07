import { isAbsolute, join, relative, sep } from "node:path";
import {
  AdditionalRuntimes,
  hubCallStep,
  type PromptRequest,
  RuntimeAdapter,
  RuntimeError,
  type RuntimeEvent,
  RuntimeLimitReached,
  UNRECORDED_TOOL_CALL,
} from "@hobbots/agents";
import {
  CONTINUATION_HEADER,
  type PlanUsage,
  type ReplyUsage,
  RUNTIME_NAMES,
  type RuntimeAvailability,
  type RuntimeEnforcement,
  RuntimeHealth,
  type RuntimeKind,
  RuntimeModel,
  RuntimeModels,
} from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { type Cause, Clock, Duration, Effect, Exit, Layer, Option, Queue, Stream } from "effect";
import { decideCall, startCall } from "./approval.ts";
import { backgroundFinished } from "./background-commands.ts";
import { sessionPolicy, toolTurn } from "./claude-code.ts";
import { type HookEnd, toolFinished } from "./command-exit.ts";
import { applyScriptedWrites } from "./fake-writes.ts";
import { mountName } from "./skills.ts";
import { commandOf, toolLabel, toolRequests } from "./tool-calls.ts";

/**
 * The fake runtime's models: a main one with every effort level, and one behind "More models"
 * that takes none.
 */
export const fakeModels = new RuntimeModels({
  runtime: "claude-code",
  source: "runtime",
  models: [
    new RuntimeModel({
      id: "fake-thinker",
      displayName: "Fake Thinker",
      description: "Echoes prompts; accepts every effort level",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      main: true,
    }),
    new RuntimeModel({
      id: "fake-quick",
      displayName: "Fake Quick",
      description: "Echoes prompts; takes no effort setting",
      efforts: [],
      main: false,
    }),
  ],
});

/** The fake Codex's one model, so a switch can change runtime and model at once. */
export const fakeCodexModels = new RuntimeModels({
  runtime: "codex",
  source: "runtime",
  models: [
    new RuntimeModel({
      id: "fake-coder",
      displayName: "Fake Coder",
      description: "Echoes prompts as the fake Codex",
      efforts: ["low", "medium", "high"],
      main: true,
    }),
  ],
});

export interface FakeRuntimeOptions {
  /** The runtime the fake answers for: Claude Code by default. */
  readonly runtime?: RuntimeKind;
  /** Pause before each event, so a reply streams visibly. */
  readonly delay?: string;
  /** How long a cancelled turn takes to end, like a real runtime shutting a turn down. */
  readonly stopDelay?: string;
  /** What the health check reports, to show a brain that cannot think (ready by default). */
  readonly availability?: RuntimeAvailability;
  /** Whether the fake pretends its sandbox started ("on", the default) or cannot start on this hub. */
  readonly sandbox?: "on" | "unavailable";
  /** Decides scripted tool calls; without it a turn has no tools. */
  readonly engine?: PolicyEngine["Service"];
  /**
   * Writes nothing in a turn that only carries work that arrived, as a lead told to stay quiet in
   * the chat between the plan and the finish does (#901). Off by default, so tests can read what
   * such a turn was told in its echo.
   */
  readonly quietContinuations?: boolean;
}

/** What the fake runtime claims to enforce. Nothing is run, so its claims are about decisions only. */
export const fakeEnforcement = (sandbox: "on" | "unavailable"): RuntimeEnforcement => ({
  toolInterception: {
    status: "verified",
    evidence: "The fake decides every scripted tool call with the policy engine.",
  },
  processSandbox:
    sandbox === "on"
      ? { status: "verified", evidence: "The fake pretends its sandbox started." }
      : { status: "unsupported", evidence: "The fake pretends the sandbox cannot start on this hub." },
  hubTools: {
    status: "verified",
    evidence:
      "The fake calls the hub tools a scripted turn names: each Charm the hob holds, Local Git, Memory, Skills and the Task tools, decided by the hub.",
  },
  toolEvents: { status: "verified", evidence: "The fake reports each scripted call's start, finish or denial." },
  toolInterruption: { status: "verified", evidence: "Cancelling the turn ends the fake's stream." },
});

/**
 * Prompts that make the fake runtime end a turn the way a provider can, so every chat state can be
 * reached without a model. Only a prompt that starts with one counts.
 */
export const FAKE_DIRECTIVES = {
  /** Writes a little, then stops responding: the reply is cut off. */
  cutOff: "fake:cut-off",
  /** Writes a little, then hits the usage limit, which refills in an hour. */
  limit: "fake:limit",
} as const;

/**
 * A prompt line `fake:fail`, anywhere in it, makes the fake cut its reply off once its scripted calls
 * are made, so the turn fails after doing its work. Unlike `fake:cut-off` it need not lead, so a
 * step or member brief, whose first line is its title, can fail (and fail again when retried).
 */
export const FAKE_FAIL_DIRECTIVE = "fake:fail";

/**
 * A prompt line `fake:once <line>` runs `<line>` the first time this fake sees it, in any session,
 * and is dropped after: a retried step that starts from the same brief then does less than the try
 * before it, as a retry can.
 */
export const FAKE_ONCE_DIRECTIVE = "fake:once";

/**
 * A prompt line `fake:compact`, anywhere in it, makes the fake report that it compacted the session
 * once the turn starts, as Claude Code and Codex do when a session grows long (#1027).
 */
const FAKE_COMPACT_DIRECTIVE = "fake:compact";

/**
 * A prompt line `fake:skill <name>` makes the fake use that skill, as a model picks one on its own
 * (ADR 029, The use line): it reports `SkillUsed` when the turn mounted the skill, and nothing
 * otherwise, as a runtime refuses a skill it was not given. The skill you picked for the message
 * (`askedSkill`) is reported as used once the turn starts, as Claude Code and Codex load it.
 */
const FAKE_SKILL_DIRECTIVE = "fake:skill ";

/**
 * The skills the fake uses in a turn: the one you picked, then those its prompt names, each once and
 * only if mounted. A skill of a set is named `<set>:<name>` (ADR 029, Skill sets).
 */
const fakeSkillUses = (request: PromptRequest, scripted: string): ReadonlyArray<RuntimeEvent> => {
  const mounted = new Map((request.skills ?? []).map((skill) => [mountName(skill), skill]));
  const asked = request.askedSkill && mounted.has(request.askedSkill) ? [request.askedSkill] : [];
  const named = scripted
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(FAKE_SKILL_DIRECTIVE))
    .map((line) => line.slice(FAKE_SKILL_DIRECTIVE.length).trim())
    .filter((name) => mounted.has(name) && !asked.includes(name));
  const used = (key: string, explicit: boolean): RuntimeEvent => {
    const mount = mounted.get(key);
    const set = mount?.set ? { set: mount.set.name } : {};
    return { _tag: "SkillUsed", source: "library", name: mount?.name ?? key, explicit, ...set };
  };
  return [...asked.map((key) => used(key, true)), ...[...new Set(named)].map((key) => used(key, false))];
};

/** The prompt with each `fake:once` line run the first time and dropped after, remembering it in `seen`. */
const onceOnly = (prompt: string, seen: Set<string>) =>
  prompt
    .split("\n")
    .flatMap((line) => {
      const once = afterDirective(line.trim(), FAKE_ONCE_DIRECTIVE);
      if (once === undefined) return [line];
      if (seen.has(once)) return [];
      seen.add(once);
      return [once];
    })
    .join("\n");

/** What the fake says when it cuts a reply off. */
export const fakeCutOffError = "Claude stopped responding";

/** Asked this, the fake runtime answers with the instructions its session follows instead of an echo. */
export const fakeInstructionsPrompt = "/instructions";

/**
 * The prompt the fake answers with the skills the turn mounted (ADR 029), one name a line, each
 * marked when it is Only when asked. Like every runtime, it loads no skill from anywhere else.
 */
export const fakeSkillsPrompt = "/skills";

/** The fake's answer to `fakeSkillsPrompt`. */
export const fakeSkillsReply = (skills: PromptRequest["skills"]) =>
  (skills ?? []).length === 0
    ? "No skills."
    : (skills ?? [])
        .map((skill) => (skill.implicit ? mountName(skill) : `${mountName(skill)} (only when asked)`))
        .join("\n");

/**
 * A prompt line `fake:tool <Tool> <argument>` asks the fake runtime to make that tool call. A
 * `Bash sleep …` call keeps running until its turn ends, as a long command does.
 */
export const FAKE_TOOL_DIRECTIVE = "fake:tool";

const scriptedInput = (tool: string, argument: string): Record<string, unknown> => {
  switch (tool) {
    case "Bash":
      return { command: argument };
    case "Glob":
    case "Grep":
      return { pattern: argument };
    case "NotebookEdit":
      return { notebook_path: argument };
    default:
      return { file_path: argument };
  }
};

/**
 * What a scripted command prints, though nothing runs: `echo` its words and `seq N` the numbers 1
 * to N, so a step can show short, long and secret-bearing output. Any other call prints nothing.
 */
const scriptedOutput = (tool: string, input: Record<string, unknown>): string | undefined => {
  const command = tool === "Bash" && typeof input.command === "string" ? input.command : "";
  const count = /^seq (\d{1,7})$/.exec(command)?.[1];
  if (count !== undefined) return `${Array.from({ length: Number(count) }, (_, i) => i + 1).join("\n")}\n`;
  return command.startsWith("echo ") ? `${command.slice("echo ".length)}\n` : undefined;
};

/**
 * What a scripted call does once it runs: the files it writes (text) or deletes (null), relative to
 * the hob's first folder, and for a command what it prints, whether as it comes, and its exit code.
 */
interface ScriptedEffect {
  readonly writes?: Readonly<Record<string, string | null>>;
  readonly output?: string;
  readonly exitCode?: number;
  readonly live?: boolean;
  /** It runs in the background, as `run_in_background` does: its call returns at once. */
  readonly background?: boolean;
  /** How long a background command runs, such as "2 seconds"; without it, it runs until its turn ends. */
  readonly runsFor?: Duration.Input;
  /**
   * A background command that outlives the reply, as one the model leaves running does (#1048,
   * #1056): the reply is written while it runs, the turn then waits on it, and once it ends the
   * fake follows up with a line on how it ended. Without `runsFor` it runs until you stop waiting.
   */
  readonly outlives?: boolean;
}

interface ScriptedCall {
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly effect?: ScriptedEffect;
}

/**
 * A prompt line `fake:run <JSON>` asks the fake runtime to run a command that really changes the
 * hob's first folder, as a script would: `{"command": "npm run format", "writes": {"a.ts": "…",
 * "old.ts": null}, "output": "…", "exitCode": 0, "live": true}`. Its writes are made, its output is
 * reported (as it comes when `live`), and a non-zero exit code fails it. Nothing else runs. A
 * command that starts with `sleep ` prints its `live` output and keeps running until its turn ends.
 * With `"background": true` the call returns at once and the command ends `runsFor` after it
 * started, reported as Claude Code reports a background task's end, before the turn completes; with
 * no `runsFor` it is still running when the turn ends (#1018).
 */
export const FAKE_RUN_DIRECTIVE = "fake:run";

/**
 * A prompt line `fake:write <path> <JSON text>` asks the fake runtime to write that text to the file
 * with its Write tool, relative to the hob's first folder.
 */
export const FAKE_WRITE_DIRECTIVE = "fake:write";

const afterDirective = (line: string, directive: string) =>
  line.startsWith(`${directive} `) ? line.slice(directive.length + 1).trim() : undefined;

/** The scripted run a `fake:run` line describes, or undefined when its JSON is not one. */
const scriptedRun = (text: string): ScriptedCall | undefined => {
  const run = parsedInput(text) as (ScriptedEffect & { readonly command?: unknown }) | string;
  if (typeof run !== "object" || run === null || typeof run.command !== "string") return undefined;
  return {
    tool: "Bash",
    input: { command: run.command, ...(run.background === true ? { run_in_background: true } : {}) },
    effect: run,
  };
};

/** The scripted write a `fake:write` line describes. */
const scriptedWrite = (text: string, cwd: string): ScriptedCall => {
  const [path = "", ...rest] = text.split(" ");
  const content = parsedInput(rest.join(" "));
  const target = isAbsolute(path) ? path : join(cwd, path);
  return {
    tool: "Write",
    input: { file_path: target, content: String(content) },
    effect: { writes: { [relative(cwd, target).split(sep).join("/")]: String(content) } },
  };
};

/** The tool call a prompt line scripts, or undefined when it scripts none. */
const scriptedCall = (line: string, cwd: string): ScriptedCall | undefined => {
  const tool = afterDirective(line, FAKE_TOOL_DIRECTIVE);
  if (tool !== undefined) {
    const [name = "", ...rest] = tool.split(" ");
    return { tool: name, input: scriptedInput(name, rest.join(" ")) };
  }
  const run = afterDirective(line, FAKE_RUN_DIRECTIVE);
  if (run !== undefined) return scriptedRun(run);
  const write = afterDirective(line, FAKE_WRITE_DIRECTIVE);
  return write === undefined ? undefined : scriptedWrite(write, cwd);
};

/** A scripted call's output, line by line as it comes, when it is `live`; none otherwise. */
const liveScripted = (call: ScriptedCall & { readonly id: string }): ReadonlyArray<RuntimeEvent> => {
  const output = call.effect?.output ?? scriptedOutput(call.tool, call.input);
  return call.effect?.live === true && output !== undefined
    ? output.split(/(?<=\n)/).map((text): RuntimeEvent => ({ _tag: "ToolOutput", id: call.id, text }))
    : [];
};

/** The events a scripted call that ran ends with: its output as it comes, then its end. */
const finishScripted = (
  call: ScriptedCall & { readonly id: string },
  folders: ReadonlyArray<string>,
): ReadonlyArray<RuntimeEvent> => {
  const folder = folders[0];
  if (call.effect?.writes !== undefined && folder !== undefined) applyScriptedWrites(call.effect.writes, folder);
  const output = call.effect?.output ?? scriptedOutput(call.tool, call.input);
  return [...liveScripted(call), toolFinished(call.id, ...hookEnd(call.tool, output, call.effect?.exitCode))];
};

/** A scripted command running in the background, and when it ends (null: not before its turn does). */
interface BackgroundRun {
  readonly call: ScriptedCall & { readonly id: string };
  readonly folders: ReadonlyArray<string>;
  readonly endsAt: number | null;
  /** It goes on after the reply is written, so the turn waits on it (#1056). */
  readonly outlives: boolean;
}

/**
 * The ends of a turn's background commands, each when it is due, as Claude Code reports a background
 * task's end: by its status and a summary that states the exit code.
 */
const backgroundEnds = (runs: ReadonlyArray<BackgroundRun>): Stream.Stream<RuntimeEvent> =>
  Stream.fromIterable(
    [...runs].filter((run) => run.endsAt !== null).sort((a, b) => (a.endsAt ?? 0) - (b.endsAt ?? 0)),
  ).pipe(
    Stream.mapEffect((run) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.sleep(Math.max(0, (run.endsAt ?? now) - now));
        const folder = run.folders[0];
        const effect = run.call.effect;
        if (effect?.writes !== undefined && folder !== undefined) applyScriptedWrites(effect.writes, folder);
        const code = effect?.exitCode ?? 0;
        const name = `Background command "${String(run.call.input.command)}"`;
        return backgroundFinished(
          run.call.id,
          code === 0
            ? { status: "completed", summary: `${name} completed (exit code 0)` }
            : { status: "failed", summary: `${name} failed with exit code ${code}` },
          effect?.output ?? scriptedOutput(run.call.tool, run.call.input),
        );
      }),
    ),
  );

/**
 * What a turn does after writing `reply` while commands it started outlive it, as Claude Code and
 * Codex do (#1048, #1056): it waits on them, and as each ends it follows up with a line on how it
 * ended, then waits again on those still running. One that never ends on its own keeps the turn
 * waiting until you stop waiting. `text` is the whole reply once every command has ended.
 */
const waitOn = (
  reply: string,
  outliving: ReadonlyArray<BackgroundRun>,
): { readonly events: Stream.Stream<RuntimeEvent>; readonly text: string } => {
  const ending = [...outliving].filter((run) => run.endsAt !== null).sort((a, b) => (a.endsAt ?? 0) - (b.endsAt ?? 0));
  const awaiting = (runs: ReadonlyArray<BackgroundRun>): ReadonlyArray<RuntimeEvent> =>
    runs.length === 0 ? [] : [{ _tag: "AwaitingCommands", ids: runs.map((run) => run.call.id) }];
  let text = reply;
  const steps = ending.map((run, index) => {
    const line = `${String(run.call.input.command)} ended.`;
    const delta = text === "" ? line : `\n\n${line}`;
    text = `${text}${delta}`;
    const ended = new Set(ending.slice(0, index + 1));
    return Stream.concat(
      backgroundEnds([run]),
      Stream.fromIterable<RuntimeEvent>([
        { _tag: "TextDelta", text: delta },
        ...awaiting(outliving.filter((each) => !ended.has(each))),
      ]),
    );
  });
  const forever = outliving.some((run) => run.endsAt === null);
  const events = [Stream.fromIterable(awaiting(outliving)), ...steps, forever ? Stream.never : Stream.empty].reduce(
    (all, next) => Stream.concat(all, next),
  );
  return { events, text };
};

/**
 * How Claude Code's hooks would report the call's end, so the fake's events take the real runtime's
 * path: a command that exits non-zero fails with an `Exit code N` error, and one that exits 0 succeeds
 * with its output.
 */
const hookEnd = (
  tool: string,
  output: string | undefined,
  exitCode: number | undefined,
): [HookEnd, string | undefined] => {
  if (exitCode !== undefined && exitCode !== 0) {
    const error = [`Exit code ${exitCode}`, ...(output === undefined || output === "" ? [] : [output])].join("\n");
    return [{ hook_event_name: "PostToolUseFailure", tool_name: tool, error, is_interrupt: false }, error];
  }
  const response = { stdout: output ?? "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false };
  return [{ hook_event_name: "PostToolUse", tool_name: tool, tool_response: response }, output];
};

/** The command a scripted call runs, in the folder the policy decided it in, or undefined for another tool. */
const scriptedCommand = (
  call: ScriptedCall & { readonly cwd: string },
  targets: ReadonlyArray<string>,
  sandbox: "on" | "unavailable",
) => commandOf(call.tool, call.input, targets[0] ?? call.cwd, sandbox === "on", call.effect?.live === true);

/**
 * What a scripted call that ran does. A background one returns at once, its end due before the turn
 * completes, if at all, whatever its command; a `sleep` command prints what it has so far as it
 * comes and keeps running; any other ends now.
 */
const ranScripted = (
  call: ScriptedCall & { readonly id: string },
  folders: ReadonlyArray<string>,
  background: Array<BackgroundRun>,
  queue: Queue.Queue<RuntimeEvent, Cause.Done>,
) =>
  Effect.gen(function* () {
    if (call.effect?.background === true) {
      const now = yield* Clock.currentTimeMillis;
      const runsFor = call.effect.runsFor;
      background.push({
        call,
        folders,
        endsAt: runsFor === undefined ? null : now + Duration.toMillis(Duration.fromInputUnsafe(runsFor)),
        outlives: call.effect.outlives === true,
      });
      return;
    }
    if (call.tool === "Bash" && String(call.input.command).startsWith("sleep ")) {
      yield* Effect.forEach(liveScripted(call), (event) => Queue.offer(queue, event), { discard: true });
      return yield* Effect.never;
    }
    yield* Effect.forEach(finishScripted(call, folders), (event) => Queue.offer(queue, event), { discard: true });
  });

/**
 * The tool calls a prompt scripts, decided as Claude Code's would be: by the policy engine, and for
 * Ask by the user through the turn's approvals. Each is reported as started and finished, or denied.
 * Only `fake:run` and `fake:write` change files, and only in the hob's first folder; nothing is run.
 */
export const scriptedToolEvents = (
  request: PromptRequest,
  engine: PolicyEngine["Service"] | undefined,
  sandbox: "on" | "unavailable" = "on",
  background: Array<BackgroundRun> = [],
): Stream.Stream<RuntimeEvent> => {
  // Commands are decided as on a hub where the sandbox started, or where it cannot start.
  // Who its commits are made as comes with the turn, as on the real runtimes (#741).
  const turn = engine ? toolTurn(request.tools, sandbox, request) : null;
  if (engine === undefined || turn === null) return Stream.empty;
  const cwd = turn.folders[0] as string;
  const calls = request.prompt
    .split("\n")
    .map((line) => line.trim())
    .flatMap((line) => {
      const call = scriptedCall(line, cwd);
      return call === undefined ? [] : [call];
    })
    .map((call, index) => ({ ...call, id: `fake-tool-${index + 1}`, cwd }))
    // Like Claude Code, a known tool not offered this turn is never called; an unknown one is refused.
    .filter((call) => toolRequests(call.tool, call.input, call.cwd) === null || turn.tools.includes(call.tool));
  return Stream.fromIterable(calls).pipe(
    Stream.flatMap((call) =>
      Stream.callback<RuntimeEvent>((queue) =>
        Effect.gen(function* () {
          const decision = yield* decideCall(
            engine,
            turn.context,
            request.approvals,
            call,
            (event) => Queue.offerUnsafe(queue, event),
            turn,
            request.redaction,
          );
          const label = toolLabel(call.tool, call.input, request.redaction?.text);
          const command =
            decision._tag === "Run" ? scriptedCommand(call, decision.verdict.targets, sandbox) : undefined;
          const ran =
            decision._tag === "Run" &&
            (yield* startCall(request.recordToolStart, (event) => Queue.offerUnsafe(queue, event), {
              _tag: "ToolStarted",
              id: call.id,
              tool: call.tool,
              operation: decision.verdict.operation,
              targets: decision.verdict.targets,
              label,
              ...(command === undefined ? {} : { command }),
            }));
          if (ran) {
            yield* ranScripted(call, turn.folders, background, queue);
          } else {
            yield* Queue.offer(queue, {
              _tag: "ToolDenied",
              id: call.id,
              tool: call.tool,
              operation: decision.verdict?.operation ?? "outside-folders",
              targets: decision.verdict?.targets ?? [],
              label,
              reason: decision._tag === "Run" ? UNRECORDED_TOOL_CALL : decision.reason,
              decidedBy: (decision._tag === "Refuse" && decision.decidedBy) || "policy",
            });
          }
          yield* Queue.end(queue);
        }),
      ),
    ),
  );
};

/**
 * A prompt line `fake:hub <tool> <JSON input>` asks the fake runtime to call that Hobbots tool
 * through the turn's hub tools (ADR 018), so every Task and Quest tool can be scripted without a
 * model. Input that is not JSON is passed as text, which the hub refuses as invalid.
 */
export const FAKE_HUB_DIRECTIVE = "fake:hub";

const parsedInput = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** A string input value `$<key>.<path>` names a detail of an earlier scripted call's answer. */
const REFERENCE = /^\$([^.\s]+)\.(\S+)$/;

/** What a scripted call's answer gave back: the details on its last line, when they are JSON. */
const answerDetails = (text: string): unknown => {
  try {
    return JSON.parse(text.split("\n").at(-1) ?? "");
  } catch {
    return undefined;
  }
};

/**
 * `input` with each `$<key>.<path>` string replaced by that detail of the answer to the earlier
 * scripted call made with that key, in any session of this fake: `$copy.task_id` or
 * `$copy.artifacts.0`. A reference to nothing stays as written, so the hub refuses it.
 */
const resolveReferences = (input: unknown, details: ReadonlyMap<string, unknown>): unknown => {
  if (typeof input === "string") {
    const match = REFERENCE.exec(input);
    if (match === null) return input;
    let value: unknown = details.get(match[1] ?? "");
    for (const part of (match[2] ?? "").split(".")) {
      value = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
    }
    return value === undefined ? input : value;
  }
  if (Array.isArray(input)) return input.map((each) => resolveReferences(each, details));
  if (input !== null && typeof input === "object") {
    return Object.fromEntries(Object.entries(input).map(([name, value]) => [name, resolveReferences(value, details)]));
  }
  return input;
};

/**
 * The hub tool calls a prompt scripts, each shown as a step. What the hub answers is added to
 * `answers`, one `<tool>: <answer>` each, for the reply to end with as a model would read it. The
 * details each answer gives back are kept in `details` under the call's key, for later calls to
 * refer to as `$<key>.<path>`.
 */
export const scriptedHubEvents = (
  request: PromptRequest,
  answers: Array<string>,
  details: Map<string, unknown> = new Map(),
): Stream.Stream<RuntimeEvent> => {
  const hub = request.hubTools;
  if (!hub) return Stream.empty;
  const calls = request.prompt
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${FAKE_HUB_DIRECTIVE} `))
    .map((line, index) => {
      const [name = "", ...rest] = line
        .slice(FAKE_HUB_DIRECTIVE.length + 1)
        .trim()
        .split(" ");
      return { id: `fake-hub-${index + 1}`, name, input: parsedInput(rest.join(" ")) };
    });
  return Stream.fromIterable(calls).pipe(
    Stream.flatMap((call) =>
      Stream.callback<RuntimeEvent>((queue) =>
        Effect.gen(function* () {
          const report = (event: RuntimeEvent) => Queue.offerUnsafe(queue, event);
          report({
            _tag: "StepStarted",
            id: call.id,
            kind: "tool",
            label: hub.tools.find((tool) => tool.name === call.name)?.label ?? call.name,
          });
          // Resolved when the call is made, so it can name what an earlier call answered.
          const answer = yield* hub.call(
            call.name,
            resolveReferences(call.input, details),
            hubCallStep(call.id, report, request.recordToolStart),
          );
          answers.push(`${call.name}: ${answer.text}`);
          const key = (call.input as { readonly key?: unknown } | null)?.key;
          if (typeof key === "string" && !answer.refused) details.set(key, answerDetails(answer.text));
          yield* Queue.offer(queue, { _tag: "StepEnded", id: call.id });
          yield* Queue.end(queue);
        }),
      ),
    ),
  );
};

/**
 * A prompt line `fake:then <line>` keeps `<line>` for the session's next turn, which runs it as if
 * its own prompt began with it. So a continuation, whose prompt Hobbots writes (ADR 019), can be
 * scripted from the turn before it: `fake:then fake:hub complete_task {…}` completes the Task in
 * the turn that the work arriving starts. Nested, `fake:then fake:then …` reaches further turns.
 */
export const FAKE_THEN_DIRECTIVE = "fake:then";

/** The lines a prompt keeps for its session's next turn. */
const keptForNext = (prompt: string) =>
  prompt
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${FAKE_THEN_DIRECTIVE} `))
    .map((line) => line.slice(FAKE_THEN_DIRECTIVE.length + 1).trim());

/** How a directive in the prompt makes the fake end its reply. */
const fakeEnding = (prompt: string) =>
  prompt.startsWith(FAKE_DIRECTIVES.cutOff) || prompt.split("\n").some((line) => line.trim() === FAKE_FAIL_DIRECTIVE)
    ? "cutOff"
    : prompt.startsWith(FAKE_DIRECTIVES.limit)
      ? "limit"
      : "complete";

/**
 * The fake Claude Code plan, the same on every read so tests can assert it: a session window 38% used
 * that refills in two hours, and a weekly one 12% used that refills in three days.
 */
const fakePlanUsage: Effect.Effect<PlanUsage> = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis;
  const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
  const meter = (kind: string, group: string, percent: number, hours: number, active: boolean) => ({
    kind,
    group,
    percent,
    resetsAt: at(hours),
    scope: null,
    severity: "normal",
    active,
  });
  return {
    runtime: "claude-code",
    reported: true,
    meters: [meter("session", "session", 38, 2, true), meter("weekly_all", "weekly", 12, 72, false)],
    extraUsage: null,
    checkedAt: new Date(now).toISOString(),
  };
});

/** The failure that ends a reply cut off or limited, as a provider would end it. */
/**
 * What a fake turn took and used, the same for every turn so tests can assert it: a session's first
 * turn writes its prompt to the cache and later ones read it, as a model API's prompt cache would.
 */
const fakeUsage = (prompt: string, reply: string, resumed: boolean): ReplyUsage => {
  const tokens = (text: string) => Math.ceil(text.length / 4);
  return {
    timeToRequestMs: 5,
    timeToFirstStreamMs: 15,
    timeToFirstTokenMs: 20,
    inputTokens: tokens(prompt),
    outputTokens: tokens(reply),
    cacheReadTokens: resumed ? 1000 : 0,
    cacheWriteTokens: resumed ? 0 : 1000,
  };
};

const fakeFailure = (
  ending: ReturnType<typeof fakeEnding>,
): Stream.Stream<never, RuntimeError | RuntimeLimitReached> =>
  ending === "cutOff"
    ? Stream.fail(new RuntimeError({ message: fakeCutOffError }))
    : ending === "limit"
      ? Stream.unwrap(
          Effect.map(Clock.currentTimeMillis, (now) =>
            Stream.fail(new RuntimeLimitReached({ resetsAt: new Date(now + 60 * 60 * 1000).toISOString() })),
          ),
        )
      : Stream.empty;

/**
 * Deterministic adapter for tests and UI work without model usage. Like Claude Code, a resumed session
 * keeps the instructions it started with unless the turn carries changed ones.
 */
/** What the fake says back: the session's instructions, the turn's skills, or the prompt. */
const fakeEcho = (request: PromptRequest, followed: string, told: string) => {
  if (request.prompt === fakeInstructionsPrompt) return followed;
  if (request.prompt === fakeSkillsPrompt) return fakeSkillsReply(request.skills);
  return `Echo: ${told}`;
};

export const makeFakeRuntime = (options: FakeRuntimeOptions = {}) => {
  const runtime = options.runtime ?? "claude-code";
  const availability = options.availability ?? "ready";
  const sandbox = options.sandbox ?? "on";
  const enforcement = fakeEnforcement(sandbox);
  // Each session's instructions, and the lines its previous turn kept for its next.
  const sessions = new Map<string, { readonly instructions: string; readonly later: ReadonlyArray<string> }>();
  // What scripted hub calls gave back, by key, for later calls in any session to refer to.
  const details = new Map<string, unknown>();
  // The `fake:once` lines already run, in any session.
  const ran = new Set<string>();
  const sendPrompt = (request: PromptRequest): Stream.Stream<RuntimeEvent, RuntimeError | RuntimeLimitReached> => {
    // A brain that is not ready cannot start a turn, as with the real runtime.
    if (availability !== "ready") {
      return Stream.fail(new RuntimeError({ message: `Fake runtime is ${availability}` }));
    }
    const sessionId =
      request.sessionId ?? `fake-${runtime === "claude-code" ? "" : `${runtime}-`}${crypto.randomUUID()}`;
    const known = sessions.get(sessionId);
    const followed = known === undefined || request.instructionsChanged ? request.instructions : known.instructions;
    // What the previous turn kept runs ahead of this turn's own prompt.
    const later = known?.later ?? [];
    const scripted = onceOnly([...later, request.prompt].join("\n"), ran);
    sessions.set(sessionId, { instructions: followed, later: keptForNext(scripted) });
    // A briefing is echoed ahead of the prompt, so a test can see what the session was told.
    const told = request.briefing ? `${request.briefing}\n\n${request.prompt}` : request.prompt;
    const echo = fakeEcho(request, followed, told);
    const quiet = options.quietContinuations === true && request.prompt.startsWith(CONTINUATION_HEADER);
    // The turn's own prompt decides first, so a line kept from before never hides its directive.
    const own = fakeEnding(request.prompt);
    const ending = own === "complete" ? fakeEnding(scripted) : own;
    const answers: Array<string> = [];
    // The reply ends with what the hub answered its scripted calls, known once they are made.
    const written = Stream.suspend(() => {
      const reply = quiet ? "" : answers.length === 0 ? echo : [echo, ...answers].join("\n\n");
      const words = reply === "" ? [] : reply.split(/(?<= )/);
      const deltas = Stream.fromIterable<RuntimeEvent>(
        (ending === "complete" ? words : words.slice(0, 2)).map((text): RuntimeEvent => ({ _tag: "TextDelta", text })),
      );
      if (ending !== "complete") return deltas;
      const waited = waitOn(
        reply,
        background.filter((run) => run.outlives),
      );
      const completed: RuntimeEvent = {
        _tag: "Completed",
        sessionId,
        text: waited.text,
        usage: fakeUsage(told, waited.text, known !== undefined),
      };
      return deltas.pipe(Stream.concat(waited.events), Stream.concat(Stream.fromIterable([completed])));
    });
    const failure = fakeFailure(ending);
    const background: Array<BackgroundRun> = [];
    // Tool calls come after the thinking step, before the reply is written.
    const stream = Stream.fromIterable<RuntimeEvent>([
      {
        _tag: "SessionStarted",
        sessionId,
        billing: "fake",
        ...sessionPolicy(toolTurn(request.tools, sandbox, request)),
      },
      ...(scripted.split("\n").some((line) => line.trim() === FAKE_COMPACT_DIRECTIVE)
        ? [{ _tag: "SessionCompacted" } as const]
        : []),
      ...fakeSkillUses(request, scripted),
      // Every reply thinks first, so the step display can be seen and tested.
      { _tag: "StepStarted", id: "thinking-1", kind: "thinking", label: "Thinking" },
      { _tag: "StepEnded", id: "thinking-1" },
    ]).pipe(
      Stream.concat(scriptedToolEvents({ ...request, prompt: scripted }, options.engine, sandbox, background)),
      Stream.concat(scriptedHubEvents({ ...request, prompt: scripted }, answers, details)),
      // Like Claude Code, the turn completes once its background commands that end have ended.
      Stream.concat(Stream.suspend(() => backgroundEnds(background.filter((run) => !run.outlives)))),
      Stream.concat(written),
      Stream.concat(failure),
    );
    const paced = options.delay ? stream.pipe(Stream.tap(() => Effect.sleep(options.delay as "10 millis"))) : stream;
    return options.stopDelay
      ? paced.pipe(
          Stream.onExit((exit) =>
            Exit.hasInterrupts(exit) ? Effect.sleep(options.stopDelay as "10 millis") : Effect.void,
          ),
        )
      : paced;
  };

  return RuntimeAdapter.of({
    health: Effect.succeed(
      new RuntimeHealth({
        runtime,
        availability,
        billing: "fake",
        version: "fake",
        detail: `Fake ${RUNTIME_NAMES[runtime]} (no model calls)`,
        checkedAt: null,
        enforcement,
      }),
    ),
    models: Effect.succeed(runtime === "claude-code" ? fakeModels : fakeCodexModels),
    enforcement: Effect.succeed(enforcement),
    // Fake Claude Code reports a plan with fixed meters; fake Codex reports none, as an API key would.
    ...(runtime === "claude-code" ? { planUsage: fakePlanUsage } : {}),
    sendPrompt,
  });
};

/** The fake runtime, deciding scripted tool calls with the hub's policy engine when there is one. */
export const FakeRuntimeLayer = (options?: FakeRuntimeOptions) =>
  Layer.effect(
    RuntimeAdapter,
    Effect.map(Effect.serviceOption(PolicyEngine), (engine) =>
      makeFakeRuntime({ ...options, ...(Option.isSome(engine) ? { engine: engine.value } : {}) }),
    ),
  );

/**
 * A fake Codex beside the fake Claude Code, so a thread can switch runtimes without either (ADR 017).
 * Its own options set what its health reports; it decides scripted tool calls like the other.
 */
export const FakeAdditionalRuntimesLayer = (options?: FakeRuntimeOptions) =>
  Layer.effect(
    AdditionalRuntimes,
    Effect.map(
      Effect.serviceOption(PolicyEngine),
      (engine) =>
        new Map([
          [
            "codex" as const,
            makeFakeRuntime({
              ...options,
              runtime: "codex",
              ...(Option.isSome(engine) ? { engine: engine.value } : {}),
            }),
          ],
        ]),
    ),
  );
