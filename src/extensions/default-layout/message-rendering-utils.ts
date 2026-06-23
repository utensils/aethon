import type { ChatMessage } from "../../types/a2ui";
import type {
  A2UIEventHandler,
  BuiltinComponentProps,
} from "../../components/A2UIRenderer";

export function forwardNestedA2UIEvent(
  onEvent: BuiltinComponentProps["onEvent"] | undefined,
): A2UIEventHandler {
  return (component, eventType, data) => {
    onEvent?.(eventType, data, component.id);
    return eventType === "tool-file-open" || eventType === "tool-file-diff";
  };
}

export function queuedDeliveryLabels(
  messages: ChatMessage[],
): Map<string, string> {
  const queued = messages.filter(
    (message) => message.role === "user" && message.delivery === "queued",
  );
  if (queued.length <= 1) return new Map();
  return new Map(
    queued.map((message, index) => [message.id, `queued #${index + 1}`]),
  );
}
