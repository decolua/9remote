// TEMP DIAGNOSTIC — Debug render count, trigger causes, stream bursts and auto-scroll events
const counts = new Map();
const lastProps = new Map();
const scrollEvents = [];
const streamStats = { chunks: 0, bytes: 0, lastChunkAt: 0, bySession: {} };

export function trackRender(componentName, props = {}) {
  const current = (counts.get(componentName) || 0) + 1;
  counts.set(componentName, current);

  // Find changed props since last render
  const prev = lastProps.get(componentName);
  const changed = [];
  if (prev) {
    const allKeys = new Set([...Object.keys(prev), ...Object.keys(props)]);
    for (const key of allKeys) {
      if (prev[key] !== props[key]) {
        changed.push(`${key}: [${typeof prev[key] === "object" ? "obj" : prev[key]}] → [${typeof props[key] === "object" ? "obj" : props[key]}]`);
      }
    }
  }
  lastProps.set(componentName, { ...props });

  const diffStr = changed.length > 0 ? ` | changed: ${changed.slice(0, 5).join(", ")}` : "";
  console.log(`%c[render-diag]%c ${componentName} #${current}${diffStr}`, "color: #ff007f; font-weight: bold", "color: inherit");
  return current;
}

export function trackScrollTrigger(source, details = {}) {
  const item = { time: new Date().toLocaleTimeString(), source, ...details };
  scrollEvents.push(item);
  if (scrollEvents.length > 100) scrollEvents.shift();
  console.warn(`%c[scroll-trigger]%c ${source}`, "color: #ffaa00; font-weight: bold", "color: inherit", details);
}

export function trackStreamChunk(sessionId, byteLength) {
  streamStats.chunks++;
  streamStats.bytes += byteLength;
  streamStats.lastChunkAt = Date.now();
  if (!streamStats.bySession[sessionId]) streamStats.bySession[sessionId] = { chunks: 0, bytes: 0 };
  streamStats.bySession[sessionId].chunks++;
  streamStats.bySession[sessionId].bytes += byteLength;

  if (streamStats.chunks % 50 === 0) {
    console.log(`%c[stream-diag]%c session=${sessionId} chunks=${streamStats.chunks} bytes=${(streamStats.bytes / 1024).toFixed(1)}KB`, "color: #00d2ff; font-weight: bold", "color: inherit");
  }
}

if (typeof window !== "undefined") {
  window.__getRenderDiag = () => {
    console.group("📊 [RENDER DIAGNOSTIC REPORT]");
    console.log("--- Component Render Counts ---");
    const renderTable = [];
    counts.forEach((count, name) => renderTable.push({ Component: name, Renders: count }));
    renderTable.sort((a, b) => b.Renders - a.Renders);
    console.table(renderTable);

    console.log("--- Stream Stats ---");
    console.log(`Total Chunks: ${streamStats.chunks}, Total KB: ${(streamStats.bytes / 1024).toFixed(1)}KB`, streamStats.bySession);

    console.log("--- Recent Scroll Triggers (Last 50) ---");
    console.table(scrollEvents.slice(-50));
    console.groupEnd();
    return { counts: Object.fromEntries(counts), streamStats, scrollEvents };
  };

  window.__resetRenderDiag = () => {
    counts.clear();
    lastProps.clear();
    scrollEvents.length = 0;
    streamStats.chunks = 0;
    streamStats.bytes = 0;
    streamStats.bySession = {};
    console.log("[render-diag] Metrics reset");
  };
}
