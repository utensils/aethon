import { useState, useEffect } from "react";
import type { TextInputProps } from "../../types/a2ui";

type Props = TextInputProps & {
  resolvedValue?: string;
  resolvedPlaceholder?: string;
  resolvedDisabled?: boolean;
  onEvent: (eventType: string, data?: unknown) => void;
};

export default function TextInput({
  resolvedValue = "",
  resolvedPlaceholder,
  resolvedDisabled = false,
  onChange,
  onEvent,
}: Props) {
  const [localValue, setLocalValue] = useState(resolvedValue);

  useEffect(() => {
    setLocalValue(resolvedValue);
  }, [resolvedValue]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setLocalValue(newValue);
    if (onChange) {
      onEvent(onChange, { value: newValue });
    }
  };

  return (
    <input
      type="text"
      className="a2ui-text-input"
      value={localValue}
      placeholder={resolvedPlaceholder}
      disabled={resolvedDisabled}
      onChange={handleChange}
    />
  );
}
