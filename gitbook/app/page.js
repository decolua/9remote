import DocsLayout from "@/components/DocsLayout";
import DocsContent from "@/components/DocsContent";
import { extractHeadings } from "@/utils/markdown";
import fs from "fs";
import path from "path";

export default function HomePage() {
  const contentPath = path.join(process.cwd(), "content", "index.md");
  const content = fs.existsSync(contentPath) 
    ? fs.readFileSync(contentPath, "utf-8")
    : "# Welcome to 9Remote Documentation\n\nContent coming soon...";
  
  const headings = extractHeadings(content);

  return (
    <DocsLayout headings={headings}>
      <DocsContent content={content} />
    </DocsLayout>
  );
}
