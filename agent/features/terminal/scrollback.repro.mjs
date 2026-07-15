// Repro: scroll-up history fetch loop — does reconstruct == original?
// Extracts the daemon's pure slicing logic verbatim (can't import ptyDaemon — it auto-starts).
// Run: node agent/features/terminal/scrollback.repro.mjs
// Asserts: (1) no dup (2) no gap (3) no multibyte corruption across fetches.

const JOIN_REPLAY_SIZE = 128 * 1024;
const HISTORY_CHUNK_SIZE = 128 * 1024;

function bufferTotal(chunks) {
  if (!chunks?.length) return 0;
  return chunks.reduce((sum, c) => sum + c.length, 0);
}
function takeBufferTail(chunks, maxLen) {
  if (!chunks?.length || maxLen <= 0) return Buffer.alloc(0);
  let remaining = maxLen;
  const parts = [];
  for (let i = chunks.length - 1; i >= 0 && remaining > 0; i--) {
    const chunk = chunks[i];
    if (chunk.length <= remaining) { parts.push(chunk); remaining -= chunk.length; }
    else { parts.push(chunk.subarray(chunk.length - remaining)); remaining = 0; }
  }
  parts.reverse();
  return Buffer.concat(parts);
}
// Verbatim copy of ptyDaemon.js takeBufferRange (line 88-120).
function takeBufferRange(chunks, haveFromEnd, chunkLen) {
  if (!chunks?.length || chunkLen <= 0) return { prefix: Buffer.alloc(0), trimmed: 0 };
  const total = bufferTotal(chunks);
  const endExclusive = total - Math.max(0, Math.min(haveFromEnd, total));
  let start = endExclusive - chunkLen;
  if (start < 0) { chunkLen += start; start = 0; }
  if (chunkLen <= 0) return { prefix: Buffer.alloc(0), trimmed: 0 };
  let offset = 0;
  const parts = [];
  for (let i = 0; i < chunks.length && chunkLen > 0; i++) {
    const chunk = chunks[i];
    const next = offset + chunk.length;
    if (next <= start) { offset = next; continue; }
    if (offset >= endExclusive) break;
    const localStart = Math.max(0, start - offset);
    const take = Math.min(chunkLen, chunk.length - localStart);
    parts.push(chunk.subarray(localStart, localStart + take));
    chunkLen -= take;
    offset = next;
  }
  let raw = Buffer.concat(parts);
  let trimmed = 0;
  const nl = raw.indexOf(0x0a);
  if (nl > 0 && nl < raw.length - 1) {
    trimmed = nl + 1;
    raw = raw.subarray(trimmed);
  }
  return { prefix: raw, trimmed };
}
// Verbatim copy of the requestHistory handler math (ptyDaemon.js 439-455).
function requestHistory(buffer, have) {
  const total = bufferTotal(buffer);
  const haveC = Math.max(0, Math.min(have || 0, total));
  const remaining = total - haveC;
  const chunkLen = Math.min(HISTORY_CHUNK_SIZE, remaining);
  const { prefix, trimmed } = chunkLen > 0 ? takeBufferRange(buffer, haveC, chunkLen) : { prefix: Buffer.alloc(0), trimmed: 0 };
  return {
    prefix, prefixLen: prefix.length, total, trimmed,
    remaining: Math.max(0, remaining - prefix.length - trimmed) + trimmed,
  };
}

// --- Build content with multibyte + ANSI + emoji, split into chunks at arbitrary boundaries ---
function buildContent(bytes) {
  const lines = [];
  const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
  let n = 0;
  while (n < bytes) {
    const kinds = [
      `line ${lines.length}: hello world ${"x".repeat(20)}`,
      cyan(`colored ${lines.length} ${"y".repeat(15)}`),
      `dòng ${lines.length}: tiếng Việt có dấu ${"z".repeat(10)}`,
      `日本語${lines.length}: テスト ${"あ".repeat(8)}`,
      `emoji ${lines.length}: 😀🚀👍 ${"e".repeat(12)}`,
    ];
    const line = kinds[lines.length % kinds.length];
    lines.push(Buffer.from(line + "\n", "utf-8"));
    n += line.length + 1;
  }
  return Buffer.concat(lines);
}

// Split a flat buffer into random-sized chunks (stress mid-multibyte splits).
function chunkRandomly(buf, seed) {
  const chunks = [];
  let i = 0;
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  while (i < buf.length) {
    const size = Math.max(1, Math.floor(rnd() * 4096) + 1); // 1..4096 bytes
    chunks.push(buf.subarray(i, Math.min(i + size, buf.length)));
    i += size;
  }
  return chunks;
}

function run(label, totalBytes, seed) {
  const content = buildContent(totalBytes);
  const buffer = chunkRandomly(content, seed);
  const total = bufferTotal(buffer);

  // Client join: tail.
  const tail = takeBufferTail(buffer, JOIN_REPLAY_SIZE);
  const mirror = [tail];
  let have = tail.length;
  let fetches = 0;
  let maxFetches = 50;

  while (have < total && maxFetches-- > 0) {
    const res = requestHistory(buffer, have);
    if (res.prefixLen === 0) break;
    mirror.unshift(res.prefix);
    have += res.prefixLen;
    fetches++;
  }

  const reconstructed = Buffer.concat(mirror);
  const pass = reconstructed.equals(content);
  const status = pass ? "PASS" : "FAIL";
  console.log(`[${status}] ${label}: total=${total} fetches=${fetches} have=${have} recon=${reconstructed.length} ${pass ? "" : "(recon != orig)"}`);

  if (!pass) {
    // Diagnose: find first divergence and report whether it's a dup or corruption.
    const minLen = Math.min(reconstructed.length, content.length);
    let firstDiff = -1;
    for (let i = 0; i < minLen; i++) {
      if (reconstructed[i] !== content[i]) { firstDiff = i; break; }
    }
    if (firstDiff >= 0) {
      const ctxOrig = content.subarray(Math.max(0, firstDiff - 20), firstDiff + 40).toString("utf-8");
      const ctxRec = reconstructed.subarray(Math.max(0, firstDiff - 20), firstDiff + 40).toString("utf-8");
      console.log(`  first diff @${firstDiff}:`);
      console.log(`    orig: ${JSON.stringify(ctxOrig)}`);
      console.log(`    recon: ${JSON.stringify(ctxRec)}`);
      // Detect duplication: is recon a prefix of content shifted, or does content appear duplicated?
      // Check if recon length > content length (dup added bytes).
      if (reconstructed.length > content.length) console.log(`  recon is ${reconstructed.length - content.length} bytes LONGER → duplication`);
      else if (reconstructed.length < content.length) console.log(`  recon is ${content.length - reconstructed.length} bytes SHORTER → data lost`);
      else console.log(`  same length → corruption (byte mismatch), likely mid-multibyte cut`);
    }
  }
  return pass;
}

let allPass = true;
// Large content → multiple fetches.
for (const bytes of [400 * 1024, 600 * 1024, 1024 * 1024]) {
  for (const seed of [1, 2, 7, 42]) {
    if (!run(`${bytes}B seed=${seed}`, bytes, seed)) allPass = false;
  }
}
// Tiny content (< JOIN_REPLAY_SIZE): join tail == whole buffer, no fetches expected.
if (!run("tiny 50KB", 50 * 1024, 3)) allPass = false;
// Content just over JOIN_REPLAY_SIZE: exactly one fetch, small remaining.
if (!run("edge 130KB", 130 * 1024, 5)) allPass = false;

// --- RACE TEST: live output arrives while a fetch is in flight ---
// Real sequence (agent/ui TerminalPane.jsx + daemon ptyDaemon.js):
//   t0: client mirror=[tail], historyBytesRef=tailLen, historyTotalRef=T0
//   t1: user scrolls top → emit requestHistory(have=tailLen) [sent value = tailLen]
//   t2: BEFORE daemon handles it, live PTY output N arrives:
//         daemon buffer += N (total→T0+N); client "output" → mirror.push(live); historyBytesRef+=N
//   t3: daemon handles requestHistory with total=T0+N, have=tailLen:
//         endExclusive = (T0+N)-tailLen = (T0-tailLen)+N  → prefix ENDS inside the live N region
//   t4: client prepends prefix (ends at T0-tailLen+N), tail starts at T0-tailLen
//         → prefix ∩ tail = [T0-tailLen, T0-tailLen+N) = N bytes → DUP at the prefix/tail seam.
//   Subsequent fetches stay contiguous from the shifted point, so the dup (N bytes) persists.
// Detect: after fetching to completion, client historyBytesRef > daemon total ⟺ dup happened.
function runLiveRace(label, baseBytes, liveChunk, injectAtFetch) {
  const content = buildContent(baseBytes);
  const buffer = chunkRandomly(content, 7);
  const T0 = bufferTotal(buffer);

  const tail = takeBufferTail(buffer, JOIN_REPLAY_SIZE);
  const mirror = [tail];
  let historyBytesRef = tail.length;
  let liveTotal = Buffer.alloc(0);
  let fetchIdx = 0;

  // Fetch loop. Each iteration = one client requestHistory. Live output injected mid-loop
  // simulates a "data" event beating the ack. The SENT `have` is historyBytesRef AT emit time;
  // the daemon sees the CURRENT buffer (post-live) when it handles the message.
  for (let guard = 0; guard < 64; guard++) {
    const haveAtEmit = historyBytesRef;

    // Live output arrives between emit and daemon handling (at the chosen fetch index).
    if (fetchIdx === injectAtFetch) {
      const liveBuf = Buffer.from(liveChunk.repeat(200), "utf-8");
      buffer.push(liveBuf);
      mirror.push(liveBuf);
      historyBytesRef += liveBuf.length;
      liveTotal = Buffer.concat([liveTotal, liveBuf]);
    }
    fetchIdx++;

    const res = requestHistory(buffer, haveAtEmit);
    if (!res.prefixLen) break;
    mirror.unshift(res.prefix);
    historyBytesRef += res.prefixLen;
    if (historyBytesRef >= bufferTotal(buffer)) break;
  }

  const daemonTotal = bufferTotal(buffer);
  const dup = historyBytesRef - daemonTotal;
  const pass = dup === 0;
  console.log(`[${pass ? "PASS" : "FAIL"}] ${label}: clientHave=${historyBytesRef} daemonTotal=${daemonTotal} ${pass ? "" : `→ DUP ${dup} bytes`}`);
  return pass;
}
console.log("\n--- live-output race tests ---");
for (const [lbl, live] of [["ascii", "LIVE OUTPUT STREAM\n"], ["utf8+cjk+emoji", "dòng live tiếng Việt 日本語 😀🚀\n"]]) {
  allPass = runLiveRace(`${lbl} inject@0`, 400 * 1024, live, 0) && allPass;
  allPass = runLiveRace(`${lbl} inject@1`, 400 * 1024, live, 1) && allPass;
  allPass = runLiveRace(`${lbl} inject@2`, 600 * 1024, live, 2) && allPass;
}

console.log(allPass ? "\nALL PASS — server byte-cursor logic correct; bug is elsewhere (client replay/xterm)" : "\nFAILURES — server logic IS the bug");
process.exit(allPass ? 0 : 1);
