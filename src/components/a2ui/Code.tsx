import type { CodeProps } from "../../types/a2ui";

type Props = CodeProps & {
  resolvedContent: string;
};

export default function Code({
  resolvedContent,
  language,
  showLineNumbers = false,
}: Props) {
  const lines = resolvedContent.split("\n");

  return (
    <div className="a2ui-code" data-language={language}>
      <pre className="a2ui-code__pre">
        {showLineNumbers ? (
          <code className="a2ui-code__code">
            {lines.map((line, idx) => (
              <div key={idx} className="a2ui-code__line">
                <span className="a2ui-code__line-number">{idx + 1}</span>
                <span className="a2ui-code__line-content">{line}</span>
              </div>
            ))}
          </code>
        ) : (
          <code className="a2ui-code__code">{resolvedContent}</code>
        )}
      </pre>
    </div>
  );
}
