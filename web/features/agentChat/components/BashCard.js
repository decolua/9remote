"use client";

import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/shared/components/ui/Collapsible";
import { OUTPUT_MAX_HEIGHT } from "@/features/agentChat/constants/agentChatConfig";

// The login page's terminal mock, reused for real command output: traffic lights,
// a title strip, and a "➜" prompt line.
export default function BashCard({ command, output, status, cwd }) {
  const isError = status === "error";
  const isRunning = status === "running";
  const hasOutput = !!output;

  return (
    <div
      className={`overflow-hidden rounded-[12px] border bg-surface-2/60 ${
        isError ? "border-danger/30" : "border-border-subtle"
      }`}
    >
      <div className="flex items-center gap-1.5 border-b border-border-subtle px-3 py-2">
        <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        <span className="ml-2 min-w-0 truncate font-mono text-[10px] text-text-subtle">
          {cwd ? `${cwd} — bash` : "bash"}
        </span>
      </div>

      <div className="p-3.5 font-mono text-[12px] leading-relaxed">
        <div className="flex gap-2">
          <span className="shrink-0 select-none text-text-subtle">➜</span>
          <span className="min-w-0 whitespace-pre-wrap break-all text-text">{command}</span>
        </div>

        {isRunning && (
          <div className="mt-1 flex items-center gap-2 text-text-subtle">
            <span className="inline-block h-[13px] w-[7px] animate-cursor-blink bg-brand-500 align-middle" />
          </div>
        )}

        {hasOutput && (
          // Output never auto-expands: a failed command's stderr can be thousands of
          // lines, and unfolding it would bury the next message.
          <Collapsible className="mt-2">
            <CollapsibleTrigger className="flex items-center gap-1.5 py-0.5 font-mono text-[11px] text-text-subtle transition-colors hover:text-text">
              output
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre
                className={`mt-1 overflow-auto whitespace-pre-wrap break-all rounded-[8px] bg-surface p-2 text-[11px] ${
                  isError ? "text-danger" : "text-text-muted"
                }`}
                style={{ maxHeight: OUTPUT_MAX_HEIGHT }}
              >
                {output}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </div>
  );
}
