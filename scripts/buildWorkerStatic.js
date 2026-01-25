#!/usr/bin/env node
/**
 * Build Worker Static Handler
 * Converts Next.js static export (client/out/) to inline JS for Cloudflare Worker
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "client/out");
const WORKER_STATIC = path.join(ROOT, "worker/src/handlers/static.js");

function escapeString(str) {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$");
}

function readFileContent(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    console.error(`Failed to read: ${filePath}`);
    return null;
  }
}

function collectFiles(dir, basePath = "") {
  const files = {};
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.join(basePath, entry.name);

    if (entry.isDirectory()) {
      Object.assign(files, collectFiles(fullPath, relativePath));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      // Skip .map files and binary files
      if (ext === ".map") continue;
      
      if ([".html", ".css", ".js", ".json", ".svg"].includes(ext)) {
        const content = readFileContent(fullPath);
        if (content) {
          files["/" + relativePath.replace(/\\/g, "/")] = {
            content,
            type: getContentType(ext)
          };
        }
      }
    }
  }

  return files;
}

function getContentType(ext) {
  const types = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon"
  };
  return types[ext] || "text/plain";
}

function generateStaticHandler(files) {
  const fileEntries = Object.entries(files)
    .map(([path, { content, type }]) => {
      return `  "${path}": { content: \`${escapeString(content)}\`, type: "${type}" }`;
    })
    .join(",\n");

  return `// Auto-generated from Next.js build - DO NOT EDIT
const staticFiles = {
${fileEntries}
};

export async function handleStaticAsset(request, env, corsHeaders) {
  const url = new URL(request.url);
  let pathname = url.pathname;

  // Normalize paths
  if (pathname === "/") pathname = "/index.html";
  if (pathname.endsWith("/")) pathname += "index.html";
  if (!pathname.includes(".") && !pathname.endsWith("/")) {
    pathname += "/index.html";
  }

  const file = staticFiles[pathname];
  if (file) {
    return new Response(file.content, {
      headers: {
        ...corsHeaders,
        "Content-Type": file.type,
        "Cache-Control": "public, max-age=3600"
      }
    });
  }

  // Fallback to index.html for SPA routing
  const indexFile = staticFiles["/index.html"];
  if (indexFile) {
    return new Response(indexFile.content, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/html",
        "Cache-Control": "no-cache"
      }
    });
  }

  return new Response("Not Found", { status: 404, headers: corsHeaders });
}
`;
}

// Main
console.log("📦 Building Worker static handler from Next.js export...");

if (!fs.existsSync(OUT_DIR)) {
  console.error("❌ Error: client/out/ directory not found. Run 'npm run build --workspace=client' first.");
  process.exit(1);
}

const files = collectFiles(OUT_DIR);
console.log(`📁 Found ${Object.keys(files).length} files`);

const handler = generateStaticHandler(files);
fs.writeFileSync(WORKER_STATIC, handler);

console.log(`✅ Generated: ${WORKER_STATIC}`);
console.log("🚀 Run 'cd worker && npx wrangler deploy' to deploy");
