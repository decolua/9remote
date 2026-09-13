"use client";

import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

// One markdown style set for every surface (AI chat, file viewer). The project has no
// @tailwindcss/typography, so `prose` classes do nothing — each tag is styled here.
// Callers override individual tags (e.g. `a` to open files, `pre` for a copy button).

// hast hands each component a `node` prop (react-markdown passes passNode) and, for some
// nodes, its own className (e.g. a task list's `contains-task-list`). Drop the former,
// keep the latter appended — spreading props last would otherwise wipe our classes.
const tag = (Tag, baseClass) =>
  function MdTag({ children, className, node: _node, ...props }) {
    return (
      <Tag className={className ? `${baseClass} ${className}` : baseClass} {...props}>
        {children}
      </Tag>
    );
  };

export const MARKDOWN_COMPONENTS = {
  h1: tag("h1", "text-xl sm:text-2xl font-bold border-b border-border-subtle pb-2 mt-5 mb-3 text-text first:mt-0"),
  h2: tag("h2", "text-lg sm:text-xl font-bold border-b border-border-subtle pb-1.5 mt-4 mb-2.5 text-text first:mt-0"),
  h3: tag("h3", "text-base sm:text-lg font-semibold mt-3.5 mb-2 text-text"),
  h4: tag("h4", "text-sm sm:text-base font-semibold mt-3 mb-1.5 text-text"),
  h5: tag("h5", "text-xs sm:text-sm font-semibold mt-2.5 mb-1 text-text"),
  h6: tag("h6", "text-xs font-semibold mt-2 mb-1 text-text-muted"),
  p: tag("p", "my-2 leading-relaxed text-text text-sm"),
  ul: tag("ul", "list-disc pl-5 my-2 space-y-1 text-sm text-text"),
  ol: tag("ol", "list-decimal pl-5 my-2 space-y-1 text-sm text-text"),
  li: tag("li", "leading-relaxed"),
  blockquote: tag("blockquote", "border-l-4 border-brand-500/40 pl-3.5 my-2.5 text-text-muted italic text-sm"),
  // Cells wrap rather than scroll: long paths/commands break across lines inside the cell
  th: tag("th", "border border-border-subtle bg-surface-2 px-3 py-1.5 font-semibold text-left text-text align-top whitespace-normal break-words"),
  td: tag("td", "border border-border-subtle px-3 py-1.5 text-text align-top whitespace-normal break-words"),
  hr: tag("hr", "border-t border-border-subtle my-4"),
  img: ({ alt = "", node: _node, ...props }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="max-w-full h-auto rounded my-2" alt={alt} {...props} />
  ),
  a: ({ children, className, node: _node, ...props }) => (
    <a
      // wrap-anywhere, not break-words: only `anywhere` shrinks min-content, so a long
      // URL no longer widens the whole column (break-word still lets it overflow).
      className={`text-brand-500 hover:underline wrap-anywhere${className ? ` ${className}` : ""}`}
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  ),
  // Full-bleed: the table fills the message column and its cells wrap instead of
  // forcing a horizontal scrollbar.
  table: ({ children, node: _node, ...props }) => (
    <table className="w-full table-fixed border-collapse border border-border-subtle text-xs my-3" {...props}>
      {children}
    </table>
  ),
  pre: ({ children, node: _node, ...props }) => (
    <pre
      className="p-3 my-2.5 rounded bg-surface-2 overflow-x-auto text-[12px] font-mono border border-border-subtle text-text [&_code]:bg-transparent [&_code]:p-0 [&_code]:border-0 [&_code]:text-text"
      {...props}
    >
      {children}
    </pre>
  ),
  // Inline code is accent-tinted with no chip background; fenced blocks keep their
  // surface (see `pre`) — the `language-*` class is how we tell the two apart.
  code: ({ children, className, node: _node, ...props }) => {
    const isBlock = /language-/.test(className || "");
    const cls = isBlock
      ? "font-mono text-[12px] text-text"
      : "font-mono text-[0.9em] text-accent wrap-anywhere";
    return (
      <code className={`${cls}${className ? ` ${className}` : ""}`} {...props}>
        {children}
      </code>
    );
  },
  input: ({ type, checked, node: _node, ...props }) => {
    if (type === "checkbox") {
      return (
        <input
          type="checkbox"
          checked={checked}
          readOnly
          className="mr-2 rounded accent-brand-500 cursor-default"
          {...props}
        />
      );
    }
    return <input type={type} {...props} />;
  }
};

// Memoized on the text: parsing is O(content), and a streaming reply re-renders its
// parent per token — without this the whole message is re-parsed every token, which is
// O(content²) over one answer. `components` still arrives as a fresh object each render,
// so it is deliberately not compared.
const MarkdownBody = memo(function MarkdownBody({ content, components }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={components ? { ...MARKDOWN_COMPONENTS, ...components } : MARKDOWN_COMPONENTS}
    >
      {content}
    </Markdown>
  );
}, (prev, next) => prev.content === next.content);

export default MarkdownBody;
