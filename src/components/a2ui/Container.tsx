import type { ReactNode } from "react";
import type { ContainerProps } from "../../types/a2ui";

type Props = ContainerProps & {
  children?: ReactNode;
};

export default function Container({
  direction = "column",
  gap = 0,
  padding = 0,
  align,
  justify,
  children,
}: Props) {
  const style: React.CSSProperties = {
    display: "flex",
    flexDirection: direction,
    gap: `${gap}px`,
    padding: `${padding}px`,
    alignItems: align,
    justifyContent: justify,
  };

  return (
    <div className="a2ui-container" style={style}>
      {children}
    </div>
  );
}
