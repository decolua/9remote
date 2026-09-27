// Android mirroring handlers over shared transport bus.

import fs from "fs";
import path from "path";
import { CHANNELS } from "../../lib/transportConstants.js";
import { createLogger } from "../../lib/logger.js";
import { isAvailable } from "./adb.js";
import { ScrcpySession } from "./scrcpySession.js";
import { encodeMobileFrame, MOBILE_FLAG_KEY, MOBILE_FLAG_CONFIG } from "./mobileFrame.js";
import { VIDEO_CHUNK_PAYLOAD, FLOW, ADAPT, DEVICE_WATCH_MS, SLEEP_ON_HIDE_MS } from "./constants.js";
import { listAll, listAvdsAsync, startAvd, stopAvd, canManageEmulators, isHostStarted, avdNameOfAsync } from "./emulator.js";
import { listSerialsAsync } from "./adb.js";
import { envStatus, installComponent, cancelInstall, sdkJobState, setJobListener, listImages, installImage, uninstallImage, listInstalledImages, hostAbi, isBusy, beginJob, endJob, setCancelled, listDeviceProfiles, createAvd, deleteAvd, wipeAvdData, listProvisionPresets, provisionPreset } from "./sdkSetup.js";
import { LogcatStream } from "./logcat.js";
import {
  listApps, foregroundApp, installApk, uninstallApp, launchApp, stopApp, clearAppData,
  openDeepLink, setRotation, getRotation, screenshot,
  stagePathFor, assertApkSize, cleanupStaged, stageDir, sleepDevice, wakeDevice
} from "./appManager.js";

const logger = createLogger("mobile");

// Scale video options with bitrate proportional to pixel count.
function scaled(options, scale) {
  if (scale >= 1) return options;
  const maxSize = Math.max(320, Math.round((options.maxSize || 1024) * scale) & ~7);
  const areaRatio = (maxSize / (options.maxSize || 1024)) ** 2;
  return {
    ...options,
    maxSize,
    bitRate: Math.max(400_000, Math.round((options.bitRate || 4_000_000) * areaRatio))
  };
}

export function isMobileAvailable() {
  return true;
}

/**
 * In-flight send window, shared by every carrier: acks are the only
 * backpressure signal that exists on both RTC and WS, so the pump never learns
 * which one is carrying the frames. Tracks frames AND bytes, treats ack-timeout
 * as "slow" (never "dead"), and remembers a congestion drop so the stream
 * resumes only at a decodable keyframe.
 */
export class FrameFlow {
  constructor({ ackWindow, winStartBytes, winMinBytes, winMaxBytes, winGrow, winShrink, ackTimeoutMs, deadSilenceMs, now = Date.now }) {
    this.ackWindow = ackWindow;
    this.ackTimeoutMs = ackTimeoutMs;
    this.deadSilenceMs = deadSilenceMs;
    this.win = winStartBytes;   // AIMD byte window — the only throughput cap that tracks the link
    this._minWin = winMinBytes;
    this._maxWin = winMaxBytes;
    this._grow = winGrow;
    this._shrink = winShrink;
    this._lossy = false;        // one shrink per loss episode
    this._sawUtil = 0;          // peak in-flight bytes since last window change
    this._now = now;
    this._timers = new Map();   // seq → expiry timer
    this._bytes = new Map();    // seq → registered byte length
    this._bytesInFlight = 0;
    this.lastAckAt = now();
    this._waitKey = false;
  }

  // Count cap is hard for everyone; the byte cap has one reserve slot so the
  // keyframe that ends a drop episode can still pass a full window.
  get hardFull() {
    return this._timers.size >= this.ackWindow;
  }

  get fullForDelta() {
    return this._timers.size >= this.ackWindow - 1 || this._bytesInFlight >= this.win;
  }

  get dead() {
    return this._now() - this.lastAckAt > this.deadSilenceMs;
  }

  get waitingKey() {
    return this._waitKey;
  }

  markDropped() {
    this._waitKey = true;
    this._punish();
  }

  // A delivered keyframe re-baselines the stream — losses before it no longer
  // say anything about the link, so let the window grow again.
  clearLoss() {
    this._lossy = false;
  }

  _punish() {
    if (this._lossy) return;
    this.win = Math.max(this._minWin, this.win * this._shrink);
    this._lossy = true;
    this._sawUtil = 0;
  }

  // Post-drop gate: deltas reference dropped predecessors — only a keyframe
  // (or the tiny config packet) may go out until one arrives.
  admit(frame) {
    if (this._waitKey && !frame.isKey && !frame.isConfig) return false;
    if (frame.isKey) this._waitKey = false;
    return true;
  }

  register(seq, byteLength) {
    this._timers.set(seq, setTimeout(() => this._expire(seq), this.ackTimeoutMs));
    this._bytes.set(seq, byteLength);
    this._bytesInFlight += byteLength;
    if (!this._lossy) this._sawUtil = Math.max(this._sawUtil, this._bytesInFlight);
  }

  // Returns bytes released by this ack — the goodput signal for ADAPT.
  ack(seq) {
    this.lastAckAt = this._now();
    let released = 0;
    for (const pending of [...this._timers.keys()]) {
      if (pending > seq) continue;
      clearTimeout(this._timers.get(pending));
      released += this._bytes.get(pending) || 0;
      this._release(pending);
    }
    if (this._lossy) return released;
    this._sawUtil = Math.max(this._sawUtil, this._bytesInFlight);
    // Grow only when the window was actually utilized and nothing was lost.
    if (this._sawUtil >= 0.9 * this.win) {
      this.win = Math.min(this._maxWin, this.win * this._grow);
      this._sawUtil = 0;
    }
    return released;
  }

  _expire(seq) {
    if (!this._bytes.has(seq)) return;
    this._timers.delete(seq);
    this._punish();
    this._release(seq);
  }

  _release(seq) {
    this._timers.delete(seq);
    this._bytesInFlight -= this._bytes.get(seq) || 0;
    this._bytes.delete(seq);
  }

  reset() {
    for (const timer of this._timers.values()) clearTimeout(timer);
    this._timers.clear();
    this._bytes.clear();
    this._bytesInFlight = 0;
    this.lastAckAt = this._now();
    this._waitKey = false;
    this._sawUtil = 0;
    // Keep the learned window — the link did not change because the session did.
  }
}

// `bus` is the transport bus endpoint: inbound events arrive here from every
// carrier (PM._dispatch fans RTC and WS into the same listeners), outbound
// traffic goes via `protocol`. Never branch on the carrier — the bus hides it.
export function setupMobileHandlers(bus) {
  const protocol = bus.data.protocol;
  if (!protocol) return;

  let session = null;
  let logcat = null;
  let activeSerial = null;
  let frameSeq = 0;
  let streamGen = 0;

  const flow = new FrameFlow(FLOW);
  let paused = false;
  // Only AVDs started by this agent may be put to sleep.
  let maySleep = false;
  let sleepTimer = null;
  const cancelSleepTimer = () => { clearTimeout(sleepTimer); sleepTimer = null; };

  const clearFlow = () => flow.reset();

  // Tear down video stream while keeping the device session active.
  const stopStream = () => {
    streamGen++;
    session?.close();
    session = null;
    clearFlow();
  };

  const stop = () => {
    stopStream();
    cancelSleepTimer();
    if (maySleep && activeSerial) sleepDevice(activeSerial);
    maySleep = false;
    activeSerial = null;
  };

  const stopLogcat = () => { logcat?.close(); logcat = null; };

  let requested = null;
  let scale = 1;
  let sampleStart = 0;
  let lastRestartAt = 0;
  let ackedBytes = 0;      // goodput numerator since the last ADAPT tick
  let dropEpisodes = 0;    // drop-mode entries since the last ADAPT tick
  let lastKeyReqAt = 0;    // forced-IDR rate limit (see FLOW.keyframeReqMinGapMs)

  // Backpressure drops whole frame to prevent undecodable partial units.
  // Dedicated mobile lane keeps video clear of file-transfer head-of-line
  // blocking; older peers without that DC fall back to the file lane.
  const sendFrame = (frame) => {
    const total = Math.max(1, Math.ceil(frame.data.length / VIDEO_CHUNK_PAYLOAD));
    const flags = (frame.isKey ? MOBILE_FLAG_KEY : 0) | (frame.isConfig ? MOBILE_FLAG_CONFIG : 0);
    const ptsMs = Number(frame.pts / 1000n) >>> 0;
    const seq = frameSeq++;
    for (let i = 0; i < total; i++) {
      const payload = frame.data.subarray(i * VIDEO_CHUNK_PAYLOAD, (i + 1) * VIDEO_CHUNK_PAYLOAD);
      const chunk = encodeMobileFrame({ frameSeq: seq, chunkIdx: i, chunkCount: total, flags, ptsMs, payload });
      if (protocol.sendBinary(CHANNELS.mobile, chunk) === false
        && protocol.sendBinary(CHANNELS.file, chunk) === false) return false;
    }
    flow.register(seq, frame.data.length);
    return true;
  };

  const pump = async (myGen, mySession) => {
    while (streamGen === myGen) {
      const waitFrom = Date.now();
      // Bounded stall: wait for window room so a saturated-but-adequate link
      // throttles to link pace. Past stallMs the link is congested — drop what
      // arrives rather than queue it stale. Once in drop-mode (waitingKey) the
      // stall is not repeated; the stream resumes at the next keyframe.
      while (!flow.waitingKey && flow.fullForDelta && streamGen === myGen) {
        if (Date.now() - waitFrom >= FLOW.stallMs) break;
        await new Promise((r) => setTimeout(r, FLOW.ackPollMs));
      }
      if (streamGen !== myGen) break;
      while (paused && streamGen === myGen) {
        await new Promise((r) => setTimeout(r, FLOW.pausePollMs));
      }
      if (streamGen !== myGen) break;
      if (flow.dead) {
        logger.info(`📱 No ack for ${Math.round(FLOW.deadSilenceMs / 1000)}s — viewer gone, stopping stream`);
        protocol.emit("mobile:ended", {});
        stop();
        return;
      }
      if (await adapt(myGen)) return;
      const frame = await mySession.readFrame();
      if (!frame || streamGen !== myGen) break;
      // UDP-style drop: a full window means the link is slower than the encoder.
      // The keyframe that ends a drop episode may still pass (reserve slot).
      if (flow.hardFull || (flow.fullForDelta && !frame.isKey && !frame.isConfig)) {
        if (!flow.waitingKey) {
          if (Date.now() - lastKeyReqAt >= FLOW.keyframeReqMinGapMs) {
            lastKeyReqAt = Date.now();
            mySession.requestKeyframe();
          }
          dropEpisodes++;
        }
        flow.markDropped();
        continue;
      }
      if (!flow.admit(frame)) continue;
      if (!sendFrame(frame)) {
        if (!frame.isKey) mySession.requestKeyframe();
        continue;
      }
      if (frame.isKey) flow.clearLoss();
    }
    if (streamGen !== myGen) return;
    protocol.emit("mobile:ended", {});
    stop();
  };

  let lastDeviceCount = -1;
  const watchDevices = async () => {
    let count = 0;
    try { count = (await listSerialsAsync()).length; } catch { count = 0; }
    if (count === lastDeviceCount) return;
    lastDeviceCount = count;
    protocol.emit("mobile:devicesChanged", { count, available: isAvailable() });
  };
  watchDevices();
  const deviceWatch = setInterval(watchDevices, DEVICE_WATCH_MS);

  const handle = (fn) => async (data, cb) => {
    const respond = typeof data === "function" ? data : cb;
    try {
      const result = await fn(typeof data === "function" ? {} : (data || {}));
      respond?.({ success: true, ...result });
    } catch (err) {
      respond?.({ success: false, error: err.message });
    }
  };

  const withSerial = (data) => {
    const serial = data?.serial || activeSerial;
    if (!serial) throw new Error("No device selected");
    return serial;
  };

  const adapt = async (myGen) => {
    if (streamGen !== myGen) return true;
    const now = Date.now();
    if (now - sampleStart < ADAPT.sampleWindowMs) return false;
    const interval = now - sampleStart;
    const goodputBps = (ackedBytes * 8 * 1000) / interval;
    ackedBytes = 0;
    const episodes = dropEpisodes;
    dropEpisodes = 0;
    sampleStart = now;

    if (!requested || now - lastRestartAt < ADAPT.minRestartGapMs) return false;
    const baseBps = Number(requested.bitRate) || 4_000_000;
    let next = scale;
    if (episodes > 0) {
      // GCC-style: congestion → bitrate ← factor × measured goodput.
      // scaled() couples rate to scale², so scale = sqrt(target/base).
      next = Math.min(ADAPT.maxScale, Math.max(ADAPT.minScale, Math.sqrt((ADAPT.goodputFactor * goodputBps) / baseBps)));
    } else if (goodputBps > 0.95 * baseBps * scale * scale) {
      next = Math.min(ADAPT.maxScale, scale * ADAPT.stepUp);
    }
    if (!Number.isFinite(next) || Math.abs(next - scale) < 0.05) return false;

    scale = next;
    lastRestartAt = now;
    const serial = activeSerial;
    logger.info(`📱 Link goodput ${(goodputBps / 1e6).toFixed(1)}Mbps, ${episodes} drop bursts → stream at ${(scale * 100).toFixed(0)}%`);
    stopStream();
    try {
      const mySession = new ScrcpySession(serial);
      const myNewGen = streamGen;
      const meta = await mySession.start(scaled(requested, scale));
      if (streamGen !== myNewGen) { mySession.close(); return true; }
      session = mySession;
      sampleStart = Date.now();
      protocol.emit("mobile:resized", { meta });
      pump(myNewGen, mySession);
    } catch (err) {
      logger.error(`adapt restart failed: ${err.message}`);
      protocol.emit("mobile:ended", {});
    }
    return true;
  };

  bus.on("mobile:deviceCount", async (data, cb) => {
    const respond = typeof data === "function" ? data : cb;
    let count = 0;
    try { count = (await listSerialsAsync()).length; } catch { count = 0; }
    respond?.({ count, available: isAvailable() });
  });

  bus.on("mobile:list", handle(async () => ({
    available: isAvailable(),
    canManageEmulators: canManageEmulators(),
    devices: isAvailable() ? await listAll() : [],
    env: await envStatus()
  })));

  const pushJob = () => {
    const state = sdkJobState();
    if (state) protocol.emit("mobile:sdkProgress", state);
  };

  const removeJobListener = setJobListener(pushJob);

  bus.on("mobile:sdkInstall", handle(async (data) => {
    const result = await installComponent(data?.component);
    watchDevices();
    return result;
  }));

  bus.on("mobile:sdkCancel", handle(async () => {
    setCancelled(true);
    return { cancelled: cancelInstall() };
  }));

  bus.on("mobile:sdkStatus", handle(async () => ({ env: await envStatus() })));

  bus.on("mobile:provisionPresets", handle(async () => ({ presets: listProvisionPresets() })));

  bus.on("mobile:provision", handle(async (data) => {
    const result = await provisionPreset(data?.presetId, {
      onStep: (label) => endJob({ step: label })
    });
    watchDevices();
    return result;
  }));

  bus.on("mobile:imageList", handle(async () => ({
    images: await listImages(),
    installed: listInstalledImages(),
    hostAbi: hostAbi()
  })));

  bus.on("mobile:imageInstall", handle(async (data) => {
    const imagePath = data?.imagePath;
    beginJob(imagePath, { kind: "image" });
    try {
      const result = await installImage(imagePath, (pct) => endJob({ percent: pct }));
      endJob({ phase: "done" });
      watchDevices();
      return result;
    } catch (err) {
      endJob({ phase: "error", error: err.message });
      throw err;
    }
  }));

  bus.on("mobile:imageUninstall", handle(async (data) => {
    const result = await uninstallImage(data?.imagePath);
    watchDevices();
    return result;
  }));

  bus.on("mobile:deviceProfiles", handle(async () => ({ profiles: await listDeviceProfiles() })));

  bus.on("mobile:avdCreate", handle(async (data) => {
    const result = await createAvd({
      name: data?.name,
      imagePath: data?.imagePath,
      deviceId: data?.deviceId
    });
    watchDevices();
    return result;
  }));

  // Refused for a running AVD to prevent disk image corruption.
  const assertStopped = async (avdName) => {
    for (const d of await listSerialsAsync()) {
      if (!d.isEmulator) continue;
      if (await avdNameOfAsync(d.serial) === avdName) {
        throw new Error("Stop the AVD before changing or deleting it");
      }
    }
  };

  bus.on("mobile:avdDelete", handle(async (data) => {
    const avdName = data?.avdName;
    await assertStopped(avdName);
    return deleteAvd(avdName);
  }));

  bus.on("mobile:avdWipe", handle(async (data) => {
    const avdName = data?.avdName;
    await assertStopped(avdName);
    return wipeAvdData(avdName);
  }));

  bus.on("mobile:avdList", handle(async () => ({ avds: await listAvdsAsync() })));

  bus.on("mobile:avdStart", handle(async (data) => {
    const avdName = data?.avdName;
    if (!avdName) throw new Error("avdName required");
    const serial = await startAvd(
      avdName,
      (phase) => protocol.emit("mobile:avdProgress", { avdName, phase }),
      { lowPower: !!data?.lowPower }
    );
    watchDevices();
    return { serial };
  }));

  bus.on("mobile:avdStop", handle(async (data) => {
    const serial = withSerial(data);
    if (activeSerial === serial) { stop(); stopLogcat(); }
    const stopped = await stopAvd(serial);
    watchDevices();
    return { stopped };
  }));

  bus.on("mobile:apps", handle(async (data) => {
    const serial = withSerial(data);
    const [apps, foreground] = await Promise.all([listApps(serial), foregroundApp(serial)]);
    return { apps, foreground };
  }));

  bus.on("mobile:launch", handle(async (data) => {
    launchApp(withSerial(data), data?.packageName);
    return {};
  }));

  bus.on("mobile:stopApp", handle(async (data) => {
    stopApp(withSerial(data), data?.packageName);
    return {};
  }));

  bus.on("mobile:clearApp", handle(async (data) => {
    clearAppData(withSerial(data), data?.packageName);
    return {};
  }));

  bus.on("mobile:uninstall", handle(async (data) => {
    uninstallApp(withSerial(data), data?.packageName);
    return {};
  }));

  bus.on("mobile:openLink", handle(async (data) => {
    openDeepLink(withSerial(data), data?.url);
    return {};
  }));

  bus.on("mobile:rotate", handle(async (data) => {
    const serial = withSerial(data);
    setRotation(serial, data?.rotation);
    return { rotation: getRotation(serial) };
  }));

  bus.on("mobile:screenshot", handle(async (data) => ({
    png: screenshot(withSerial(data)).toString("base64")
  })));

  bus.on("mobile:apkStage", handle(async (data) => {
    assertApkSize(data?.size);
    const fileName = path.basename(stagePathFor(data?.name));
    return { targetDir: stageDir(), fileName };
  }));

  bus.on("mobile:install", handle(async (data) => {
    // Join staged filename to staging dir to avoid path traversal and cross-OS separator issues.
    const fileName = path.basename(String(data?.fileName || ""));
    const apkPath = path.join(stageDir(), fileName);
    if (!fileName || !fileName.toLowerCase().endsWith(".apk") || !fs.existsSync(apkPath)) {
      throw new Error("APK must be staged first");
    }
    try {
      const { packageName } = installApk(withSerial(data), apkPath);
      if (packageName && data?.launch !== false) {
        try { launchApp(withSerial(data), packageName); } catch { /* no launcher activity */ }
      }
      return { packageName };
    } finally {
      cleanupStaged(apkPath);
    }
  }));

  bus.on("mobile:logcatStart", handle(async (data) => {
    const serial = withSerial(data);
    stopLogcat();
    const opts = { ...data };
    if (!("packageName" in opts)) opts.packageName = (await foregroundApp(serial))?.packageName || null;
    logcat = new LogcatStream(serial, opts, (lines) => protocol.emit("mobile:logcat", { lines })).start();
    return { packageName: opts.packageName };
  }));

  bus.on("mobile:logcatFilter", handle(async (data) => {
    if (!logcat) throw new Error("Logcat not running");
    logcat.setFilter(data);
    return {};
  }));

  bus.on("mobile:logcatStop", () => stopLogcat());

  bus.on("mobile:start", async (data, cb) => {
    stop();
    const serial = data?.serial;
    if (!serial) return cb?.({ success: false, error: "serial required" });
    try {
      await wakeDevice(serial);
      const mySession = new ScrcpySession(serial);
      const myGen = streamGen;
      const meta = await mySession.start(data?.options || {});
      if (streamGen !== myGen) {
        mySession.close();
        return cb?.({ success: false, error: "superseded" });
      }
      session = mySession;
      activeSerial = serial;
      maySleep = await isHostStarted(serial);
      frameSeq = 0;
      requested = data?.options || {};
      paused = false;
      scale = 1;
      ackedBytes = 0;
      dropEpisodes = 0;
      lastKeyReqAt = 0;
      sampleStart = Date.now();
      lastRestartAt = Date.now();
      pump(myGen, mySession);
      logger.info(`📱 Mirroring ${meta.deviceName} (${meta.width}x${meta.height} ${meta.codec})`);
      cb?.({ success: true, meta });
    } catch (err) {
      logger.error(`start failed: ${err.message}`);
      stop();
      cb?.({ success: false, error: err.message });
    }
  });

  bus.on("mobile:stop", () => stop());

  bus.on("mobile:input", (data) => {
    session?.input(data);
  });

  bus.on("mobile:ack", (data) => {
    const seq = data?.seq;
    if (Number.isFinite(seq)) ackedBytes += flow.ack(seq);
  });

  bus.on("mobile:visible", (data) => {
    const visible = data?.visible !== false;
    if (visible === !paused) return;
    paused = !visible;
    if (!paused) {
      cancelSleepTimer();
      if (maySleep && activeSerial) wakeDevice(activeSerial);
      return;
    }
    logger.info("📱 Viewer hidden — pausing stream");
    cancelSleepTimer();
    if (!maySleep) return;
    const serial = activeSerial;
    sleepTimer = setTimeout(() => {
      sleepTimer = null;
      if (paused && serial === activeSerial) sleepDevice(serial);
    }, SLEEP_ON_HIDE_MS);
  });

  bus.on("mobile:keyframe", () => {
    session?.requestKeyframe();
  });

  bus.on("disconnect", () => { stop(); stopLogcat(); clearInterval(deviceWatch); removeJobListener(); });
}
