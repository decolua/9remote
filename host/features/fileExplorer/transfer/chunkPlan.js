// Split a file size into contiguous chunks for streaming transfer.
// Pure logic shared by upload (client) and download (agent).
export function planChunks(size, chunkSize) {
  if (size <= 0) return [];
  const chunks = [];
  let offset = 0;
  while (offset < size) {
    const length = Math.min(chunkSize, size - offset);
    chunks.push({ offset, length });
    offset += length;
  }
  return chunks;
}
