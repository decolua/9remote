import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const contentDir = path.join(__dirname, "..", "content");
const outputFile = path.join(__dirname, "..", "generated", "content.json");

function getAllMdFiles(dir, basePath = "") {
  const files = fs.readdirSync(dir);
  let mdFiles = {};

  files.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      Object.assign(mdFiles, getAllMdFiles(filePath, path.join(basePath, file)));
    } else if (file.endsWith(".md")) {
      const slug = path.join(basePath, file.replace(/\.md$/, ""));
      const normalizedSlug = slug.split(path.sep).join("/");
      const content = fs.readFileSync(filePath, "utf-8");
      mdFiles[normalizedSlug] = content;
    }
  });

  return mdFiles;
}

// Generate content JSON
const content = getAllMdFiles(contentDir);

// Ensure output directory exists
const outputDir = path.dirname(outputFile);
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Write JSON file
fs.writeFileSync(outputFile, JSON.stringify(content, null, 2));

console.log(`✅ Generated content.json with ${Object.keys(content).length} pages`);
