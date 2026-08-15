"use client";

// Markdown mapped onto the app's own tokens. Typography plugin is not installed, so each
// element carries its spacing explicitly.
export const MARKDOWN_COMPONENTS = {
  p: ({ children }) => <div className="mb-2 last:mb-0">{children}</div>,
  h1: ({ children }) => <h1 className="mb-2 mt-3 text-[15px] font-semibold text-text first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-3 text-[14px] font-semibold text-text first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1.5 mt-2.5 text-[13px] font-semibold text-text first:mt-0">{children}</h3>,
  ul: ({ children }) => <ul className="mb-2 list-outside list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 list-outside list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="marker:text-text-subtle">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-text">{children}</strong>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 italic text-text-subtle">{children}</blockquote>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-brand-500 hover:underline">
      {children}
    </a>
  ),
  hr: () => <hr className="my-3 border-border-subtle" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="min-w-full border-collapse text-[12px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border-subtle bg-surface-2 px-2 py-1 text-left font-semibold text-text">{children}</th>
  ),
  td: ({ children }) => <td className="border border-border-subtle px-2 py-1">{children}</td>,
  pre: ({ children }) => <>{children}</>,
  code: ({ inline, children }) => {
    const text = String(children ?? "");
    // A fenced block always renders as a block; a short inline span stays inline.
    if (inline || !text.includes("\n")) {
      return (
        <code className="rounded-[6px] border border-border-subtle bg-surface-2 px-1.5 py-0.5 font-mono text-[0.9em] text-text">
          {children}
        </code>
      );
    }
    return (
      <pre className="my-2 overflow-x-auto rounded-[8px] border border-border-subtle bg-surface-2 p-2.5 font-mono text-[11px] leading-relaxed text-text">
        <code>{children}</code>
      </pre>
    );
  },
};
