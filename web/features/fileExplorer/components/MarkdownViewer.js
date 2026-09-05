"use client";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "@/shared/i18n";

const COMPONENTS = {
  h1: ({ children, ...props }) => (
    <h1 className="text-xl sm:text-2xl font-bold border-b border-border-subtle pb-2 mt-5 mb-3 text-text first:mt-0" {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 className="text-lg sm:text-xl font-bold border-b border-border-subtle pb-1.5 mt-4 mb-2.5 text-text first:mt-0" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 className="text-base sm:text-lg font-semibold mt-3.5 mb-2 text-text" {...props}>
      {children}
    </h3>
  ),
  h4: ({ children, ...props }) => (
    <h4 className="text-sm sm:text-base font-semibold mt-3 mb-1.5 text-text" {...props}>
      {children}
    </h4>
  ),
  h5: ({ children, ...props }) => (
    <h5 className="text-xs sm:text-sm font-semibold mt-2.5 mb-1 text-text" {...props}>
      {children}
    </h5>
  ),
  h6: ({ children, ...props }) => (
    <h6 className="text-xs font-semibold mt-2 mb-1 text-text-muted" {...props}>
      {children}
    </h6>
  ),
  p: ({ children, ...props }) => (
    <p className="my-2 leading-relaxed text-text text-sm" {...props}>
      {children}
    </p>
  ),
  a: ({ children, ...props }) => (
    <a className="text-brand-500 hover:underline break-words" target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  ),
  ul: ({ children, ...props }) => (
    <ul className="list-disc pl-5 my-2 space-y-1 text-sm text-text" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol className="list-decimal pl-5 my-2 space-y-1 text-sm text-text" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }) => (
    <li className="leading-relaxed" {...props}>
      {children}
    </li>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote className="border-l-4 border-brand-500/40 pl-3.5 my-2.5 text-text-muted italic text-sm" {...props}>
      {children}
    </blockquote>
  ),
  pre: ({ children, ...props }) => (
    <pre className="p-3 my-2.5 rounded bg-surface-2 overflow-x-auto text-[12px] font-mono border border-border-subtle text-text [&_code]:bg-transparent [&_code]:p-0 [&_code]:border-0" {...props}>
      {children}
    </pre>
  ),
  code: ({ children, className, ...props }) => (
    <code className={`px-1.5 py-0.5 rounded bg-surface-2 text-[12px] font-mono text-text border border-border-subtle/50 ${className || ""}`} {...props}>
      {children}
    </code>
  ),
  table: ({ children, ...props }) => (
    <div className="overflow-x-auto my-3">
      <table className="w-full border-collapse border border-border-subtle text-xs" {...props}>
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...props }) => (
    <th className="border border-border-subtle bg-surface-2 px-3 py-1.5 font-semibold text-left text-text" {...props}>
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td className="border border-border-subtle px-3 py-1.5 text-text" {...props}>
      {children}
    </td>
  ),
  hr: ({ ...props }) => (
    <hr className="border-t border-border-subtle my-4" {...props} />
  ),
  img: ({ ...props }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="max-w-full h-auto rounded my-2" alt="" {...props} />
  ),
  input: ({ type, checked, ...props }) => {
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
  },
};

export default function MarkdownViewer({ content }) {
  const { t } = useI18n();

  if (!content?.trim()) {
    return (
      <div className="h-full flex items-center justify-center text-text-muted text-xs">
        {t("common.empty", { defaultValue: "Empty file" })}
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-4 sm:p-6 bg-bg select-text">
      <div className="max-w-4xl mx-auto">
        <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
          {content}
        </Markdown>
      </div>
    </div>
  );
}
