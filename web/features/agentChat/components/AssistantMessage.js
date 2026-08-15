"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MARKDOWN_COMPONENTS } from "./markdownComponents";

// The assistant speaks full-width with no bubble — its turns are long and often contain
// code, so a bubble would waste the column and fight the code blocks.
export default function AssistantMessage({ text, tool }) {
  return (
    <div className="chat-row">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-[9px] bg-brand-500 text-white shadow-lg shadow-brand-500/30">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5" />
          </svg>
        </span>
        <span className="text-[13px] font-semibold capitalize text-text">{tool || "assistant"}</span>
      </div>
      <div className="pl-8 text-[13px] leading-relaxed text-text-muted">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
          {text}
        </ReactMarkdown>
      </div>
    </div>
  );
}
