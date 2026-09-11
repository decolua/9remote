"use client";

import MarkdownBody from "@/shared/components/ui/MarkdownBody";
import { useI18n } from "@/shared/i18n";

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
        <MarkdownBody content={content} />
      </div>
    </div>
  );
}
