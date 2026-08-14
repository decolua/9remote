// DataTransfer → upload items, preserving folder structure.
// Drag-drop exposes a DirectoryEntry tree (webkitGetAsEntry); clipboard paste only
// exposes flat files, so the caller falls back to `files` there.

// Read all entries from a DirectoryReader (readEntries returns batches).
export function readAllEntries(reader) {
  return new Promise((resolve) => {
    const out = [];
    const step = () => reader.readEntries((batch) => {
      if (!batch.length) resolve(out);
      else { out.push(...batch); step(); }
    }, () => resolve(out));
    step();
  });
}

// Recursively walk a DataTransferItem entry into [{ file, relativePath }].
export async function traverseEntry(entry, prefix, out) {
  const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, relativePath: rel });
  } else if (entry.isDirectory) {
    const children = await readAllEntries(entry.createReader());
    for (const child of children) await traverseEntry(child, rel, out);
  }
}

// Convert a drop/paste DataTransfer into upload items (folders preserved).
export async function dataTransferToItems(dataTransfer) {
  const out = [];
  const itemList = [...(dataTransfer.items || [])];
  const entries = itemList.map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) {
    for (const e of entries) await traverseEntry(e, "", out);
  } else {
    for (const f of (dataTransfer.files || [])) out.push({ file: f, relativePath: f.name });
  }
  return out;
}
