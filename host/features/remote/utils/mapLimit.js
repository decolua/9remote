// Map with bounded concurrency, preserving order; slotId (0..limit-1) is stable per worker.
export async function mapLimit(items, limit, fn) {
  const ret = new Array(items.length);
  let i = 0;
  const width = Math.min(limit, items.length);
  const workers = Array.from({ length: width }, async (_, slotId) => {
    while (i < items.length) {
      const idx = i++;
      ret[idx] = await fn(items[idx], idx, slotId);
    }
  });
  await Promise.all(workers);
  return ret;
}
