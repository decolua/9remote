import DocsLayout from "@/components/DocsLayout";
import DocsContent from "@/components/DocsContent";
import { extractHeadings } from "@/utils/markdown";
import { notFound } from "next/navigation";
import fs from "fs";
import path from "path";

export default async function DocPage({ params }) {
  const resolvedParams = await params;
  const slug = resolvedParams.slug.join("/");
  const contentPath = path.join(process.cwd(), "content", `${slug}.md`);
  
  if (!fs.existsSync(contentPath)) {
    notFound();
  }
  
  const content = fs.readFileSync(contentPath, "utf-8");
  const headings = extractHeadings(content);

  return (
    <DocsLayout headings={headings}>
      <DocsContent content={content} />
    </DocsLayout>
  );
}

export async function generateStaticParams() {
  const contentDir = path.join(process.cwd(), "content");
  
  if (!fs.existsSync(contentDir)) {
    return [];
  }

  const getAllMdFiles = (dir, basePath = "") => {
    const files = fs.readdirSync(dir);
    let mdFiles = [];

    files.forEach(file => {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        mdFiles = mdFiles.concat(getAllMdFiles(filePath, path.join(basePath, file)));
      } else if (file.endsWith(".md") && file !== "index.md") {
        const slug = path.join(basePath, file.replace(/\.md$/, ""));
        mdFiles.push({ slug: slug.split(path.sep) });
      }
    });

    return mdFiles;
  };

  return getAllMdFiles(contentDir);
}
