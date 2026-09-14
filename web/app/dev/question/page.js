"use client";

// TEMP DIAGNOSTIC — local preview of the ask-user gate. Delete when done.
import { AiQuestionCard } from "@/features/ai/components/cards/AiQuestionCard";

const QUESTIONS = [
  {
    question: "Which background should the pane use?",
    multiSelect: false,
    options: [
      { label: "Keep the global pool", description: "Every pane follows the workspace setting." },
      { label: "Pin a wallpaper", description: "Only this session gets its own image." },
      { label: "Solid colour", description: "No image, just the theme surface." }
    ]
  }
];

const MULTI = [
  {
    question: "Which panes should the new layout open?",
    multiSelect: true,
    options: [
      { label: "Terminal", description: "A shell in the workspace root." },
      { label: "AI chat", description: "The agent pane for the active engine." },
      { label: "Files", description: "The explorer panel on the right." }
    ]
  },
  {
    question: "Anything else to note?",
    options: [{ label: "No", description: "Just open them." }]
  }
];

export default function DevQuestionPage() {
  return (
    <div className="min-h-screen bg-bg p-6 flex flex-col gap-6 max-w-md">
      <AiQuestionCard questions={QUESTIONS} onResolve={() => {}} />
      <AiQuestionCard questions={MULTI} onResolve={() => {}} />
      <AiQuestionCard
        questions={QUESTIONS}
        answers={'User has answered your questions: "Which background should the pane use?"="Pin a wallpaper".'}
      />
    </div>
  );
}
