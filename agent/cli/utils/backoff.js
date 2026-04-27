// Compute next backoff delay (ms) based on strategy + attempt count (1-indexed)
export function computeDelay({ strategy, baseMs, maxMs }, attempt) {
  const a = Math.max(1, attempt);
  const raw = strategy === "exp" ? baseMs * Math.pow(2, a - 1) : baseMs * a;
  return Math.min(raw, maxMs);
}

// Run task with infinite retry; supports cancellation via shared ctx
// task: async () => boolean (true = success → stop; false/throw = retry)
export async function retryForever({ config, task, label = "task", log = () => {}, ctx = {} }) {
  let attempt = 0;
  while (!ctx.cancelled) {
    attempt++;
    try {
      const ok = await task(attempt);
      if (ok) return true;
    } catch (err) {
      log(`❌ ${label} attempt ${attempt} error: ${err?.message || err}`);
    }
    if (ctx.cancelled) return false;
    const delay = computeDelay(config, attempt);
    log(`🔄 ${label} retry in ${delay}ms (attempt ${attempt})`);
    await new Promise((r) => setTimeout(r, delay));
  }
  return false;
}
