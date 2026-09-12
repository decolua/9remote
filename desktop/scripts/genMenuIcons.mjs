// Renders lucide icons to single-color PNGs for the tray menu (run manually, output committed).
import { mkdirSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import path from "path";
import sharp from "sharp";

const OUT_DIR = fileURLToPath(new URL("../src-tauri/icons/menu/", import.meta.url));
const LUCIDE_DIR = fileURLToPath(new URL("../../node_modules/lucide-react/dist/esm/icons/", import.meta.url));
// Neutral gray: muda renders menu icons in full color (it never sets the AppKit
// template flag), so a template image isn't available — this is the one value
// that stays legible on both the light and dark system menu.
const COLOR = "#8E8E93";
const SIZE = 36; // 2x of the 18pt box macOS renders menu icons into
const PAD = 4; // viewBox units of margin — shrinks the glyph to ~13.5pt apparent

const ICONS = {
  pair: "qr-code",
  local: "monitor",
  remote: "globe",
  restart: "rotate-cw",
  update: "download",
  quit: "power",
};

const GEOMETRY_ATTRS = {
  rect: ["x", "y", "width", "height", "rx", "ry"],
  circle: ["cx", "cy", "r"],
  ellipse: ["cx", "cy", "rx", "ry"],
  line: ["x1", "y1", "x2", "y2"],
  path: ["d"],
  polyline: ["points"],
  polygon: ["points"],
};

async function readIconNode(name) {
  const mod = await import(pathToFileURL(path.join(LUCIDE_DIR, `${name}.js`)).href);
  return mod.__iconNode;
}

function buildSvg(node) {
  const shapes = node
    .map(([tag, attrs]) => {
      const allowed = GEOMETRY_ATTRS[tag];
      if (!allowed) throw new Error(`unsupported lucide tag: ${tag}`);
      const geom = allowed
        .filter((key) => attrs[key] !== undefined)
        .map((key) => `${key}="${attrs[key]}"`)
        .join(" ");
      return `<${tag} ${geom}/>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-PAD} ${-PAD} ${24 + PAD * 2} ${24 + PAD * 2}" fill="none" stroke="${COLOR}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${shapes}</svg>`;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [file, lucideName] of Object.entries(ICONS)) {
  const svg = buildSvg(await readIconNode(lucideName));
  await sharp(Buffer.from(svg)).resize(SIZE, SIZE).png().toFile(path.join(OUT_DIR, `${file}.png`));
  console.log(`wrote ${file}.png (${lucideName})`);
}
