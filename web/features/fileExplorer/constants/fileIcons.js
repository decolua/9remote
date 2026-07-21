// VSCode-style file & folder icons (from vscode-icons.team).
// SVG assets live in /public/icons/{file-types,folder-types}; mapping in vscodeIcons.json.
import iconData from "./vscodeIcons.json";

const { fileMapping, fileNameMapping, folderMapping } = iconData;

const FILE_BASE = "/icons/file-types";
const FOLDER_BASE = "/icons/folder-types";

const DEFAULT_FILE_ICON = `${FILE_BASE}/default.svg`;
const DEFAULT_FOLDER_ICON = `${FOLDER_BASE}/default.svg`;
const DEFAULT_FOLDER_OPEN_ICON = `${FOLDER_BASE}/default-open.svg`;

// Get extension key (without dot, lowercase). Dotfiles like ".gitignore" keep full name.
function getExtKey(name) {
  if (!name) return "";
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return lower;
  return lower.slice(dot + 1);
}

// Resolve a file's icon URL. Returns { src, alt }.
export function resolveFileIconSrc(file) {
  if (!file) return { src: DEFAULT_FILE_ICON, alt: "file" };
  if (file.type === "folder") return resolveFolderIconSrc(file.name, false);

  const lowerName = (file.name || "").toLowerCase();
  const ext = getExtKey(file.name);

  // Special full filenames first
  if (fileNameMapping[lowerName]) {
    const iconName = fileNameMapping[lowerName];
    return { src: `${FILE_BASE}/${iconName}.svg`, alt: iconName };
  }
  // By extension
  if (fileMapping[ext]) {
    const iconName = fileMapping[ext];
    return { src: `${FILE_BASE}/${iconName}.svg`, alt: iconName };
  }
  return { src: DEFAULT_FILE_ICON, alt: "file" };
}

// Resolve a folder's icon URL. open=true picks the opened variant if present.
export function resolveFolderIconSrc(name, open = false) {
  const lower = (name || "").toLowerCase();
  const iconName = folderMapping[lower];
  if (iconName) {
    return {
      src: open ? `${FOLDER_BASE}/${iconName}-open.svg` : `${FOLDER_BASE}/${iconName}.svg`,
      alt: iconName,
    };
  }
  return { src: open ? DEFAULT_FOLDER_OPEN_ICON : DEFAULT_FOLDER_ICON, alt: "folder" };
}

// Render a file icon <img>. Kept the same call shape as the previous SVG helper.
export function resolveFileIcon(file, size = 16) {
  const { src, alt } = resolveFileIconSrc(file);
  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      className="pointer-events-none select-none"
      draggable="false"
    />
  );
}

// Render a folder icon <img>.
export function resolveFolderIcon(name, open = false, size = 16) {
  const { src, alt } = resolveFolderIconSrc(name, open);
  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      className="pointer-events-none select-none"
      draggable="false"
    />
  );
}
