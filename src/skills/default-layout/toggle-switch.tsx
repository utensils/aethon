/**
 * Pill-shaped toggle switch — used inline in the sidebar's extensions
 * section and inside the settings-panel Extensions list. Accessible
 * `role="switch"` semantics: Space / Enter activates, `aria-checked`
 * mirrors the visual state, focus ring uses the accent.
 *
 * The component is controlled: `checked` drives the visual position
 * and `onChange` fires the next-state value. Callers translate that
 * into whatever event they need (e.g. `toggle-extension` with the
 * `disabled` flag set to !next). When `disabled` is true the toggle
 * renders muted and ignores activation — used for failed extensions
 * where flipping the switch wouldn't accomplish anything.
 */
import type { CSSProperties, KeyboardEvent, MouseEvent } from "react";

export interface ToggleSwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel: string;
  /** Optional title attribute (native tooltip). */
  title?: string;
  /** Optional class hook so callers can target the switch in their own
   *  styling (e.g. additional spacing inside a row). */
  className?: string;
  style?: CSSProperties;
}

export function ToggleSwitch({
  checked,
  onChange,
  disabled = false,
  ariaLabel,
  title,
  className,
  style,
}: ToggleSwitchProps) {
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    // The toggle frequently lives inside a clickable parent row (sidebar
    // items emit "select" on click). Stop propagation so flipping the
    // switch doesn't double-fire row-level selection.
    e.stopPropagation();
    if (disabled) return;
    onChange(!checked);
  };
  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      onChange(!checked);
    }
  };
  const classes = [
    "ae-toggle",
    checked ? "ae-toggle-on" : "ae-toggle-off",
    disabled ? "ae-toggle-disabled" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      title={title}
      tabIndex={disabled ? -1 : 0}
      className={classes}
      style={style}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <span className="ae-toggle-track" aria-hidden="true">
        <span className="ae-toggle-thumb" />
      </span>
    </button>
  );
}
