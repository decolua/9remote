import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeSlug from "rehype-slug";
import { BookOpen, Terminal, Monitor, FolderOpen, HelpCircle, MessageCircle } from "lucide-react";

const PAGE_ICONS = {
  "Welcome to 9Remote": BookOpen,
  "Getting Started": BookOpen,
  "Using GitHub Codespaces": Monitor,
  "Terminal": Terminal,
  "Remote Desktop": Monitor,
  "File Explorer": FolderOpen,
  "Troubleshooting": HelpCircle,
  "Frequently Asked Questions": MessageCircle,
};

export function parseMarkdown(content) {
  return content;
}

export function MarkdownRenderer({ content }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight, rehypeSlug]}
      className="markdown-content"
      components={{
        h1: ({ node, children, ...props }) => {
          const text = children?.toString() || "";
          const IconComponent = PAGE_ICONS[text];
          const id = text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
          
          return (
            <h1 id={id} {...props}>
              {IconComponent && <IconComponent className="inline-block mr-3" />}
              {children}
            </h1>
          );
        },
        h2: ({ node, ...props }) => <h2 id={props.children?.toString().toLowerCase().replace(/[^a-z0-9]+/g, "-")} {...props} />,
        h3: ({ node, ...props }) => <h3 id={props.children?.toString().toLowerCase().replace(/[^a-z0-9]+/g, "-")} {...props} />,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

export function extractHeadings(content) {
  const headingRegex = /^(#{2,3})\s+(.+)$/gm;
  const headings = [];
  let match;

  while ((match = headingRegex.exec(content)) !== null) {
    const level = match[1].length;
    const text = match[2];
    const id = text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    
    headings.push({
      level,
      text,
      id
    });
  }

  return headings;
}
