import type { A2UIPayload, ChatMessage } from "./types/a2ui";

export interface AskUserChoice {
  id: string;
  label: string;
  description?: string;
}

export interface AskUserInput {
  id?: string;
  title?: string;
  prompt: string;
  choices: AskUserChoice[];
  allowText?: boolean;
}

export interface AskUserAnswer {
  questionId: string;
  choiceId?: string;
  label: string;
  text?: string;
}

export interface AskUserChatOptions {
  input: AskUserInput;
  tabId: string;
  appendMessage: (msg: ChatMessage, tabId?: string) => void;
  persistLocalChatMessage?: (msg: ChatMessage, tabId: string) => Promise<boolean>;
}

const QUESTION_EVENT = "aethon-question-answer";

export function questionAnswerEventName(): string {
  return QUESTION_EVENT;
}

export function emitQuestionAnswer(answer: AskUserAnswer): void {
  window.dispatchEvent(new CustomEvent(QUESTION_EVENT, { detail: answer }));
}

export function questionPayload(
  input: AskUserInput,
  questionId: string,
  answer?: AskUserAnswer,
): A2UIPayload {
  return {
    components: [
      {
        id: `question-${questionId}`,
        type: "question-card",
        props: {
          questionId,
          title: input.title ?? "Aethon setup",
          prompt: input.prompt,
          choices: input.choices,
          allowText: input.allowText === true,
          answer,
        },
      },
    ],
  };
}

export function createQuestionMessage(
  input: AskUserInput,
  questionId: string,
  messageId: string,
  answer?: AskUserAnswer,
): ChatMessage {
  return {
    id: messageId,
    role: "system",
    a2ui: questionPayload(input, questionId, answer),
    createdAt: Date.now(),
  };
}

export function askUserWithChat({
  input,
  tabId,
  appendMessage,
  persistLocalChatMessage,
}: AskUserChatOptions): Promise<AskUserAnswer> {
  const questionId = input.id ?? crypto.randomUUID();
  const messageId = `question-message-${questionId}`;
  const pending = createQuestionMessage(input, questionId, messageId);
  appendMessage(pending, tabId);
  void persistLocalChatMessage?.(pending, tabId);

  return new Promise((resolve) => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<AskUserAnswer>).detail;
      if (!detail || detail.questionId !== questionId) return;
      window.removeEventListener(QUESTION_EVENT, handler);
      const answered = createQuestionMessage(input, questionId, messageId, detail);
      appendMessage(answered, tabId);
      void persistLocalChatMessage?.(answered, tabId);
      resolve(detail);
    };
    window.addEventListener(QUESTION_EVENT, handler);
  });
}
