// test-claude-web/src/components/MarkdownView.jsx
import React, { useState } from "react";
import ReactMarkdown from "react-markdown";

function CodeBlock({ children, className }) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || "");
  const lang = match ? match[1] : "";
  const codeText = String(children).replace(/\n$/, "");

  const handleCopy = () => {
    navigator.clipboard.writeText(codeText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="my-2.5 rounded-xl border border-white/10 bg-black/60 overflow-hidden font-mono text-xs shadow-md">
      {/* Code Header */}
      <div className="px-3.5 py-1.5 bg-white/5 border-b border-white/10 flex items-center justify-between text-[11px] text-slate-400 select-none">
        <span className="font-semibold text-slate-300 uppercase tracking-wider">{lang || "code"}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 hover:text-white transition-colors px-2 py-0.5 rounded hover:bg-white/10"
        >
          {copied ? (
            <>
              <span className="text-emerald-400">✓</span>
              <span className="text-emerald-300 text-[10px]">Đã chép</span>
            </>
          ) : (
            <>
              <span>📋</span>
              <span className="text-[10px]">Sao chép</span>
            </>
          )}
        </button>
      </div>

      {/* Code Content */}
      <pre className="p-3.5 overflow-x-auto text-slate-200 leading-relaxed">
        <code>{codeText}</code>
      </pre>
    </div>
  );
}

export function MarkdownView({ content }) {
  if (!content) return null;

  return (
    <div className="markdown-content text-slate-100 text-sm leading-relaxed flex flex-col gap-2.5">
      <ReactMarkdown
        components={{
          code({ inline, className, children, ...props }) {
            const hasNewline = String(children).includes("\n");
            if (!inline && (hasNewline || className)) {
              return <CodeBlock className={className}>{children}</CodeBlock>;
            }
            return (
              <code className="px-1.5 py-0.5 rounded bg-black/40 border border-white/10 text-amber-300 font-mono text-[12px] break-words" {...props}>
                {children}
              </code>
            );
          },
          h1: ({ children }) => (
            <h1 className="text-base font-bold text-white mt-3 mb-1 border-b border-white/10 pb-1.5">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-sm font-semibold text-white mt-2.5 mb-1 text-sky-300">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-xs font-semibold text-slate-200 mt-2 mb-0.5">{children}</h3>
          ),
          ul: ({ children }) => (
            <ul className="list-disc list-inside flex flex-col gap-1 pl-1 text-slate-200">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal list-inside flex flex-col gap-1 pl-1 text-slate-200">{children}</ol>
          ),
          li: ({ children }) => (
            <li className="leading-relaxed">{children}</li>
          ),
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto rounded-lg border border-white/10">
              <table className="w-full text-left border-collapse text-xs">{children}</table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-white/5 border-b border-white/10 text-slate-300 font-semibold">{children}</thead>
          ),
          th: ({ children }) => (
            <th className="px-3 py-2 border-r border-white/5 last:border-r-0 font-mono">{children}</th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-2 border-t border-white/5 border-r last:border-r-0 font-mono text-slate-300">{children}</td>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-blue-500 pl-3 py-0.5 text-slate-400 italic bg-blue-500/5 rounded-r">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-sky-400 underline hover:text-sky-300 transition-colors">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
