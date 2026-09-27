// One scrcpy session: pushes the server jar, opens the video + control sockets
// through an adb forward, and exposes framed H.264 access units plus an input
// encoder. Wire framing is validated against scrcpy v3 — see SCRCPY_VERSION.

import net from "net";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
  SCRCPY_VERSION, SCRCPY_JAR_NAME, DEVICE_JAR_PATH, STREAM_DEFAULTS, ADB_TIMEOUTS,
  PREAMBLE_SIZE, FRAME_HEADER_SIZE, MAX_FRAME_BYTES, MAX_READER_BUFFER_BYTES,
  CONTROL_TYPE, TOUCH_ACTION, ANDROID_KEY, TEXT_MAX_BYTES,
  TAP_HOLD_MS, MOVE_MIN_INTERVAL_MS, SWIPE_MIN_MS, SWIPE_MAX_MS, SWIPE_STEP_MS, SCROLL_RANGE
} from "./constants.js";
import { pushJar, forwardAbstract, removeForward, hasAbstractSocket, spawnShell, getScreenSize } from "./adb.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The jar ships inside the package: dev layout agent/features/mobile/vendor/,
// bundled layout agent/dist/vendor/.
const JAR_PATH = (() => {
  const primary = path.join(__dirname, "vendor", SCRCPY_JAR_NAME);
  if (fs.existsSync(primary)) return primary;
  return path.join(__dirname, "..", "vendor", SCRCPY_JAR_NAME);
})();

const CODEC_IDS = { 0x68323634: "h264", 0x68323635: "h265", 0x00617631: "av1" };
const PACKET_FLAG_CONFIG = 1n << 63n;
const PACKET_FLAG_KEY = 1n << 62n;
const PTS_MASK = ~(PACKET_FLAG_CONFIG | PACKET_FLAG_KEY);

const PRESSURE_FULL = 0xffff;
const BUTTON_PRIMARY = 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// scrcpy parses scid as a signed 32-bit hex int, so the high bit must stay clear.
function randomScid() {
  return Math.floor(Math.random() * 0x7fffffff).toString(16).padStart(8, "0");
}

/** Length-prefixed reader over a socket — resolves reads once N bytes are buffered. */
class FramedReader {
  constructor(socket) {
    this.chunks = [];
    this.offset = 0;
    this.total = 0;
    this.waiters = [];
    this.err = null;

    socket.on("data", (d) => {
      if (this.total + d.length > MAX_READER_BUFFER_BYTES) return this._fail(new Error("video reader overflow"));
      this.chunks.push(d);
      this.total += d.length;
      this._flush();
    });
    socket.on("error", (e) => this._fail(e));
    socket.on("close", () => this._fail(new Error("video socket closed")));
  }

  _fail(err) {
    this.err = err;
    this.chunks = [];
    this.total = 0;
    while (this.waiters.length) this.waiters.shift().reject(err);
  }

  read(n) {
    if (this.err) return Promise.reject(this.err);
    return new Promise((resolve, reject) => {
      this.waiters.push({ n, resolve, reject });
      this._flush();
    });
  }

  // Push bytes back so the preamble's trailing data is re-read as frame stream.
  prepend(data) {
    if (!data.length) return;
    if (this.offset > 0 && this.chunks.length) {
      this.chunks[0] = this.chunks[0].subarray(this.offset);
      this.offset = 0;
    }
    this.chunks.unshift(data);
    this.total += data.length;
    this._flush();
  }

  _consume(n) {
    const out = Buffer.allocUnsafe(n);
    let written = 0;
    while (written < n) {
      const chunk = this.chunks[0];
      const take = Math.min(n - written, chunk.length - this.offset);
      chunk.copy(out, written, this.offset, this.offset + take);
      written += take;
      this.offset += take;
      this.total -= take;
      if (this.offset === chunk.length) { this.chunks.shift(); this.offset = 0; }
    }
    return out;
  }

  _flush() {
    while (this.waiters.length && this.total >= this.waiters[0].n) {
      const w = this.waiters.shift();
      w.resolve(this._consume(w.n));
    }
  }
}

// scrcpy variants disagree on whether the video socket leads with a dummy byte,
// so detect the codec-meta alignment instead of blindly skipping one.
function parsePreamble(buf) {
  for (const offset of [0, 1]) {
    const metaAt = offset + 64;
    if (metaAt + 12 > buf.length) continue;
    const codec = CODEC_IDS[buf.readUInt32BE(metaAt)];
    const width = buf.readUInt32BE(metaAt + 4);
    const height = buf.readUInt32BE(metaAt + 8);
    if (!codec || width < 1 || height < 1 || width > 16384 || height > 16384) continue;
    return {
      deviceName: buf.subarray(offset, offset + 64).toString("utf8").replace(/\0+$/, ""),
      codec, width, height,
      extra: buf.subarray(metaAt + 12)
    };
  }
  throw new Error(`unrecognized scrcpy preamble: ${buf.toString("hex", 0, 24)}`);
}

function connectOnce(port) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`connect tcp:${port} timed out`)); }, ADB_TIMEOUTS.connect);
    sock.once("connect", () => { clearTimeout(timer); sock.removeAllListeners("error"); resolve(sock); });
    sock.once("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

// ─── Control packets ────────────────────────────────────────────────────────

function touchPacket(action, x, y, screen, pointerId = 0n) {
  const buf = Buffer.allocUnsafe(32);
  let o = 0;
  buf.writeUInt8(CONTROL_TYPE.injectTouch, o); o += 1;
  buf.writeUInt8(action, o); o += 1;
  buf.writeBigUInt64BE(pointerId, o); o += 8;
  buf.writeInt32BE(Math.round(x), o); o += 4;
  buf.writeInt32BE(Math.round(y), o); o += 4;
  buf.writeUInt16BE(screen.width, o); o += 2;
  buf.writeUInt16BE(screen.height, o); o += 2;
  buf.writeUInt16BE(action === TOUCH_ACTION.up ? 0 : PRESSURE_FULL, o); o += 2;
  buf.writeUInt32BE(BUTTON_PRIMARY, o); o += 4;
  buf.writeUInt32BE(action === TOUCH_ACTION.up ? 0 : BUTTON_PRIMARY, o);
  return buf;
}

function keyPacket(action, keycode) {
  const buf = Buffer.allocUnsafe(14);
  buf.writeUInt8(CONTROL_TYPE.injectKeycode, 0);
  buf.writeUInt8(action, 1);
  buf.writeInt32BE(keycode, 2);
  buf.writeInt32BE(0, 6);   // repeat
  buf.writeInt32BE(0, 10);  // meta state
  return buf;
}

// Truncate on a character boundary — a split multi-byte char would be garbage.
function textPacket(text) {
  const parts = [];
  let total = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch, "utf8");
    if (total + n > TEXT_MAX_BYTES) break;
    parts.push(ch);
    total += n;
  }
  const bytes = Buffer.from(parts.join(""), "utf8");
  const buf = Buffer.allocUnsafe(5 + bytes.length);
  buf.writeUInt8(CONTROL_TYPE.injectText, 0);
  buf.writeUInt32BE(bytes.length, 1);
  bytes.copy(buf, 5);
  return buf;
}

// scrcpy's own scroll message: one packet instead of the ~17 touch packets a
// simulated swipe costs, and Android treats it as a real scroll rather than a
// drag — so fling physics and nested scrolling behave correctly.
// hscroll/vscroll are i16 fixed-point over [-SCROLL_RANGE, SCROLL_RANGE].
function scrollPacket(x, y, hscroll, vscroll, screen) {
  const buf = Buffer.allocUnsafe(21);
  buf.writeUInt8(CONTROL_TYPE.injectScroll, 0);
  buf.writeInt32BE(Math.round(x), 1);
  buf.writeInt32BE(Math.round(y), 5);
  buf.writeUInt16BE(screen.width, 9);
  buf.writeUInt16BE(screen.height, 11);
  buf.writeInt16BE(toFixedI16(hscroll / SCROLL_RANGE), 13);
  buf.writeInt16BE(toFixedI16(vscroll / SCROLL_RANGE), 15);
  buf.writeUInt32BE(0, 17);   // buttons
  return buf;
}

// Normalised [-1, 1] float to the i16 fixed-point scrcpy expects.
function toFixedI16(value) {
  const clamped = Math.max(-1, Math.min(1, value));
  return clamped >= 1 ? 0x7fff : Math.round(clamped * 0x8000);
}

function backOrScreenOnPacket(action) {
  const buf = Buffer.allocUnsafe(2);
  buf.writeUInt8(CONTROL_TYPE.backOrScreenOn, 0);
  buf.writeUInt8(action, 1);
  return buf;
}

// ─── Session ────────────────────────────────────────────────────────────────

export class ScrcpySession {
  constructor(serial) {
    this.serial = serial;
    this.meta = null;
    this.screen = null;
    this.closed = false;
    this._proc = null;
    this._videoSock = null;
    this._controlSock = null;
    this._reader = null;
    this._port = null;
    // Move coalescer — see MOVE_MIN_INTERVAL_MS.
    this._movePending = null;
    this._moveLastAt = 0;
    this._moveTimer = null;
  }

  async start(opts = {}) {
    const { maxSize, bitRate, maxFps, keyFrameInterval } = { ...STREAM_DEFAULTS, ...opts };
    const scid = randomScid();
    const socketName = `scrcpy_${scid}`;

    try {
      await pushJar(this.serial, JAR_PATH, DEVICE_JAR_PATH);
      this._port = await forwardAbstract(this.serial, socketName);

      // priority/latency: realtime hints so the encoder emits packets as
      // produced instead of holding a buffer (scrcpy defaults them since #6670;
      // our pinned 3.1 predates it).
      const codecOpts = ["priority=0", "latency=1"];
      if (keyFrameInterval > 0) codecOpts.push(`i-frame-interval=${keyFrameInterval}`);

      this._proc = spawnShell(this.serial, [
        `CLASSPATH=${DEVICE_JAR_PATH}`,
        "app_process", "/", "com.genymobile.scrcpy.Server", SCRCPY_VERSION,
        `scid=${scid}`,
        "log_level=error",
        "audio=false",
        "tunnel_forward=true",
        "control=true",
        "send_dummy_byte=true",
        "send_codec_meta=true",
        "send_frame_meta=true",
        "send_device_meta=true",
        `max_size=${maxSize}`,
        `video_bit_rate=${bitRate}`,
        `max_fps=${maxFps}`,
        `video_codec_options=${codecOpts.join(",")}`,
        "cleanup=true"
      ]);

      await this._waitForSocket(socketName);

      // tunnel_forward mode: scrcpy streams only once every configured socket is
      // connected, so open both before reading the preamble.
      this._videoSock = await connectOnce(this._port);
      this._controlSock = await connectOnce(this._port);
      this._controlSock.on("data", () => {}); // drain clipboard events
      this._controlSock.on("error", () => {});

      this._reader = new FramedReader(this._videoSock);
      const preamble = parsePreamble(await this._reader.read(PREAMBLE_SIZE));
      this._reader.prepend(preamble.extra);

      // Touch packets carry the size the coordinates are relative to, and
      // scrcpy expects that to be the ENCODED size — it rescales to the display
      // itself. Passing physical px silently lands every tap in the wrong place.
      this.screen = { width: preamble.width, height: preamble.height };
      const physical = await getScreenSize(this.serial);
      this.meta = {
        deviceName: preamble.deviceName,
        codec: preamble.codec,
        width: preamble.width,
        height: preamble.height,
        screenWidth: physical?.width ?? preamble.width,
        screenHeight: physical?.height ?? preamble.height
      };
      return this.meta;
    } catch (err) {
      this.close();
      throw err;
    }
  }

  async _waitForSocket(name) {
    const deadline = Date.now() + ADB_TIMEOUTS.socketWait;
    while (Date.now() < deadline) {
      if (this.closed) throw new Error("session closed while starting");
      if (await hasAbstractSocket(this.serial, name)) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for @${name}`);
  }

  /** Next access unit, or null when the stream ends. */
  async readFrame() {
    if (this.closed || !this._reader) return null;
    try {
      const header = await this._reader.read(FRAME_HEADER_SIZE);
      const ptsRaw = header.readBigUInt64BE(0);
      const size = header.readUInt32BE(8);
      if (size === 0 || size > MAX_FRAME_BYTES) throw new Error(`invalid frame size ${size}`);
      const data = await this._reader.read(size);
      return {
        data,
        pts: ptsRaw & PTS_MASK,
        isConfig: (ptsRaw & PACKET_FLAG_CONFIG) !== 0n,
        isKey: (ptsRaw & PACKET_FLAG_KEY) !== 0n
      };
    } catch {
      return null;
    }
  }

  _write(buf) {
    if (this.closed || !this._controlSock?.writable) return false;
    return this._controlSock.write(buf);
  }

  // Keep only the newest pending move; inject it at >= MOVE_MIN_INTERVAL_MS of
  // real time since the last one, so the device sees finger velocity that
  // matches what actually happened, however the network grouped the events.
  _coalescedMove(x, y, screen, pointerId) {
    this._movePending = { x, y, screen, pointerId };
    const elapsed = Date.now() - this._moveLastAt;
    if (elapsed >= MOVE_MIN_INTERVAL_MS) {
      this._flushMove();
    } else if (!this._moveTimer) {
      this._moveTimer = setTimeout(() => { this._moveTimer = null; this._flushMove(); }, MOVE_MIN_INTERVAL_MS - elapsed);
    }
  }

  _flushMove() {
    const move = this._movePending;
    if (!move || this.closed) return;
    this._movePending = null;
    this._moveLastAt = Date.now();
    this._write(touchPacket(TOUCH_ACTION.move, move.x, move.y, move.screen, move.pointerId));
  }

  _discardPendingMove() {
    this._movePending = null;
    if (this._moveTimer) { clearTimeout(this._moveTimer); this._moveTimer = null; }
  }

  /** Ask the encoder for a fresh keyframe — used when a viewer joins mid-stream. */
  requestKeyframe() {
    return this._write(Buffer.from([CONTROL_TYPE.resetVideo]));
  }

  /**
   * Inject one input event. Coordinates are unit floats (0..1) so the client
   * never needs to know the device resolution. Every field is validated here:
   * this is the trust boundary, and the packet writers throw on out-of-range
   * values (an unvalidated pointerId alone is enough to reject the message).
   */
  async input(msg) {
    if (!this.screen) return;
    const screen = this.screen;
    // Clamp rather than reject: a coordinate a pixel outside the canvas is a
    // rounding artifact, not an attack, and dropping it would swallow real taps.
    const unit = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null);
    const px = (n) => unit(n) * screen.width;
    const py = (n) => unit(n) * screen.height;
    const valid = (...ns) => ns.every((n) => unit(n) !== null);

    switch (msg?.type) {
      case "touch": {
        const action = TOUCH_ACTION[msg.action];
        if (action === undefined || !valid(msg.x, msg.y)) return;
        // isInteger(1e30) is true but the field is u64 — bound it by the safe
        // integer range, which is well under the wire limit.
        const id = msg.pointerId;
        const pointerId = Number.isSafeInteger(id) && id >= 0 ? BigInt(id) : 0n;
        this._write(touchPacket(action, px(msg.x), py(msg.y), screen, pointerId));
        return;
      }
      case "tap": {
        if (!valid(msg.x, msg.y)) return;
        this._write(touchPacket(TOUCH_ACTION.down, px(msg.x), py(msg.y), screen));
        await sleep(TAP_HOLD_MS);
        this._write(touchPacket(TOUCH_ACTION.up, px(msg.x), py(msg.y), screen));
        return;
      }
      case "swipe": {
        if (!valid(msg.x1, msg.y1, msg.x2, msg.y2)) return;
        const requested = Number.isFinite(msg.durationMs) ? msg.durationMs : 250;
        const dur = Math.min(SWIPE_MAX_MS, Math.max(SWIPE_MIN_MS, requested));
        const steps = Math.max(8, Math.round(dur / SWIPE_STEP_MS));
        this._write(touchPacket(TOUCH_ACTION.down, px(msg.x1), py(msg.y1), screen));
        for (let i = 1; i < steps; i++) {
          const t = i / steps;
          await sleep(dur / steps);
          if (this.closed) return;
          this._write(touchPacket(TOUCH_ACTION.move, px(msg.x1 + (msg.x2 - msg.x1) * t), py(msg.y1 + (msg.y2 - msg.y1) * t), screen));
        }
        await sleep(dur / steps);
        if (this.closed) return;
        this._write(touchPacket(TOUCH_ACTION.up, px(msg.x2), py(msg.y2), screen));
        return;
      }
      case "key": {
        const code = Number.isInteger(msg.keycode) ? msg.keycode : ANDROID_KEY[msg.name];
        if (!Number.isInteger(code) || code < 0 || code > 0xffff) return;
        // back maps to BACK_OR_SCREEN_ON so it also wakes a sleeping device.
        if (msg.name === "back") {
          this._write(backOrScreenOnPacket(TOUCH_ACTION.down));
          this._write(backOrScreenOnPacket(TOUCH_ACTION.up));
          return;
        }
        this._write(keyPacket(TOUCH_ACTION.down, code));
        this._write(keyPacket(TOUCH_ACTION.up, code));
        return;
      }
      case "scroll": {
        if (!valid(msg.x, msg.y)) return;
        const h = Number.isFinite(msg.hscroll) ? msg.hscroll : 0;
        const v = Number.isFinite(msg.vscroll) ? msg.vscroll : 0;
        if (!h && !v) return;
        this._write(scrollPacket(px(msg.x), py(msg.y), h, v, screen));
        return;
      }
      case "text":
        if (typeof msg.text === "string" && msg.text) this._write(textPacket(msg.text));
        return;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this._discardPendingMove();
    try { this._videoSock?.destroy(); } catch {}
    try { this._controlSock?.destroy(); } catch {}
    try { this._proc?.kill("SIGKILL"); } catch {}
    if (this._port !== null) {
      try { removeForward(this.serial, this._port); } catch {}
    }
  }
}
