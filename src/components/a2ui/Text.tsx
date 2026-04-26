import type { TextProps } from "../../types/a2ui";

type Props = TextProps & {
  resolvedContent: string;
};

export default function Text({ resolvedContent, variant = "body", color }: Props) {
  const className = `a2ui-text a2ui-text--${variant}`;
  const style = color ? { color } : undefined;

  return (
    <span className={className} style={style}>
      {resolvedContent}
    </span>
  );
}
