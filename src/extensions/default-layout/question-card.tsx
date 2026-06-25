import { useMemo, useState } from "react";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import {
  emitQuestionAnswer,
  type AskUserAnswer,
  type AskUserChoice,
} from "../../questions";

export function QuestionCard({ component }: BuiltinComponentProps) {
  const props = component.props as
    | {
        questionId?: unknown;
        title?: unknown;
        prompt?: unknown;
        choices?: unknown;
        allowText?: unknown;
        answer?: unknown;
      }
    | undefined;
  const questionId =
    typeof props?.questionId === "string" ? props.questionId : component.id;
  const title = typeof props?.title === "string" ? props.title : "Question";
  const prompt = typeof props?.prompt === "string" ? props.prompt : "";
  const choices = useMemo(
    () => normalizeChoices(props?.choices),
    [props?.choices],
  );
  const answer = normalizeAnswer(props?.answer);
  const [customText, setCustomText] = useState("");
  const disabled = Boolean(answer);

  function choose(choice: AskUserChoice) {
    if (disabled) return;
    emitQuestionAnswer({
      questionId,
      choiceId: choice.id,
      label: choice.label,
    });
  }

  function submitCustom() {
    const text = customText.trim();
    if (disabled || !text) return;
    emitQuestionAnswer({
      questionId,
      label: text,
      text,
    });
  }

  return (
    <section className="ae-question-card" aria-label={title}>
      <div className="ae-question-card-head">
        <span className="ae-question-card-kicker">{title}</span>
        {answer && <span className="ae-question-card-state">answered</span>}
      </div>
      {prompt && <p className="ae-question-card-prompt">{prompt}</p>}
      <div className="ae-question-card-choices">
        {choices.map((choice) => (
          <button
            key={choice.id}
            type="button"
            className={
              answer?.choiceId === choice.id
                ? "ae-question-choice is-selected"
                : "ae-question-choice"
            }
            disabled={disabled}
            onClick={() => choose(choice)}
          >
            <span>{choice.label}</span>
            {choice.description && <small>{choice.description}</small>}
          </button>
        ))}
      </div>
      {props?.allowText === true && !answer && (
        <form
          className="ae-question-custom"
          onSubmit={(event) => {
            event.preventDefault();
            submitCustom();
          }}
        >
          <input
            value={customText}
            onChange={(event) => setCustomText(event.currentTarget.value)}
            placeholder="Custom answer"
            aria-label="Custom answer"
          />
          <button type="submit" disabled={!customText.trim()}>
            Send
          </button>
        </form>
      )}
      {answer && <p className="ae-question-answer">Selected: {answer.label}</p>}
    </section>
  );
}

function normalizeChoices(value: unknown): AskUserChoice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    if (!label) return [];
    return [
      {
        id:
          typeof raw.id === "string" && raw.id.trim()
            ? raw.id.trim()
            : `choice-${index + 1}`,
        label,
        description:
          typeof raw.description === "string" && raw.description.trim()
            ? raw.description.trim()
            : undefined,
      },
    ];
  });
}

function normalizeAnswer(value: unknown): AskUserAnswer | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const questionId = typeof raw.questionId === "string" ? raw.questionId : "";
  const label = typeof raw.label === "string" ? raw.label : "";
  if (!questionId || !label) return null;
  return {
    questionId,
    label,
    choiceId: typeof raw.choiceId === "string" ? raw.choiceId : undefined,
    text: typeof raw.text === "string" ? raw.text : undefined,
  };
}
