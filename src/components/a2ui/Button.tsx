import type { ButtonProps } from "../../types/a2ui";

type Props = ButtonProps & {
  resolvedLabel: string;
  resolvedDisabled: boolean;
  onEvent: (eventType: string, data?: unknown) => void;
};

export default function Button({
  resolvedLabel,
  variant = "primary",
  resolvedDisabled,
  onClick,
  onEvent,
}: Props) {
  const handleClick = () => {
    if (onClick && !resolvedDisabled) {
      onEvent(onClick, {});
    }
  };

  return (
    <button
      type="button"
      className={`a2ui-button a2ui-button--${variant}`}
      onClick={handleClick}
      disabled={resolvedDisabled}
    >
      {resolvedLabel}
    </button>
  );
}
