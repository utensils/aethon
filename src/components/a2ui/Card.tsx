import type { ReactNode } from "react";
import type { CardProps } from "../../types/a2ui";

type Props = CardProps & {
  resolvedTitle?: string;
  resolvedDescription?: string;
  resolvedPadding?: number;
  children?: ReactNode;
};

export default function Card({
  resolvedTitle,
  resolvedDescription,
  resolvedPadding = 16,
  children,
}: Props) {
  const style = {
    padding: `${resolvedPadding}px`,
  };

  return (
    <div className="a2ui-card" style={style}>
      {resolvedTitle && <div className="a2ui-card__title">{resolvedTitle}</div>}
      {resolvedDescription && <div className="a2ui-card__subtitle">{resolvedDescription}</div>}
      <div className="a2ui-card__content">{children}</div>
    </div>
  );
}
