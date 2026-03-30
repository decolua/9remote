import DocsLayout from "@/components/DocsLayout";
import DocsContent from "@/components/DocsContent";
import { extractHeadings } from "@/utils/markdown";
import { notFound } from "next/navigation";
import contentData from "@/generated/content.json";

export default async function DocPage({ params }) {
  const resolvedParams = await params;
  const slug = resolvedParams.slug.join("/");
  
  const content = contentData[slug];
  if (!content) {
    notFound();
  }
  
  const headings = extractHeadings(content);

  return (
    <DocsLayout headings={headings}>
      <DocsContent content={content} />
    </DocsLayout>
  );
}

export async function generateStaticParams() {
  return Object.keys(contentData)
    .filter(key => key !== "index")
    .map(slug => ({
      slug: slug.split("/")
    }));
}

export const dynamicParams = false;
