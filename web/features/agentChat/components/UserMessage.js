"use client";

// What the user typed, in the TUI or here. Right-aligned brand bubble.
export default function UserMessage({ text }) {
  return (
    <div className="chat-row flex justify-end">
      <div className="max-w-[85%] rounded-[14px] rounded-br-[4px] bg-brand-500 px-3.5 py-2 text-[13px] leading-relaxed text-white shadow-lg shadow-brand-500/20 sm:max-w-[32rem]">
        <span className="whitespace-pre-wrap break-words">{text}</span>
      </div>
    </div>
  );
}
