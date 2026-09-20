// Android mirroring handlers over shared transport bus.

import fs from "fs";
import path from "path";
import { CHANNELS } from "../../lib/transportConstants.js";
import { createLogger } from "../../lib/logger.js";
import { isAvailable } from "./adb.js";
import { ScrcpySession } from "./scrcpySession.js";
import { encodeMobileFrame, MOBILE_FLAG_KEY, MOBILE_FLAG_CONFIG } from "./mobileFrame.js";
import { VIDEO_CHUNK_PAYLOAD, FLOW, ADAPT, DEVICE_WATCH_MS, SLEEP_ON_HIDE_MS } from "./constants.js";
import { listAll, listAvdsAsync, startAvd, stopAvd, canManageEmulators, isAgentStarted, avdNameOfAsync } from "./emulator.js";
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

export function setupMobileHandlers(socket) {
  const protocol = socket.data.protocol;
  if (!protocol) return;

  let session = null;
  let logcat = null;
  let activeSerial = null;
  let frameSeq = 0;
  let streamGen = 0;

  let inFlight = new Set();
  let ackTimers = new Map();
  let deadAcks = 0;
  let paused = false;
  // Only AVDs started by this agent may be put to sleep.
  let maySleep = false;
  let sleepTimer = null;
  const cancelSleepTimer = () => { clearTimeout(sleepTimer); sleepTimer = null; };

  const clearFlow = () => {
    for (const timer of ackTimers.values()) clearTimeout(timer);
    ackTimers.clear();
    inFlight.clear();
    deadAcks = 0;
  };

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
  let blockedMs = 0;
  let sampleStart = 0;
  let lastRestartAt = 0;

  // Backpressure drops whole frame to prevent undecodable partial units.
  const sendFrame = (frame) => {
    const total = Math.max(1, Math.ceil(frame.data.length / VIDEO_CHUNK_PAYLOAD));
    const flags = (frame.isKey ? MOBILE_FLAG_KEY : 0) | (frame.isConfig ? MOBILE_FLAG_CONFIG : 0);
    const ptsMs = Number(frame.pts / 1000n) >>> 0;
    const seq = frameSeq++;
    for (let i = 0; i < total; i++) {
      const payload = frame.data.subarray(i * VIDEO_CHUNK_PAYLOAD, (i + 1) * VIDEO_CHUNK_PAYLOAD);
      const chunk = encodeMobileFrame({ frameSeq: seq, chunkIdx: i, chunkCount: total, flags, ptsMs, payload });
      if (protocol.sendBinary(CHANNELS.file, chunk) === false) return false;
    }
    inFlight.add(seq);
    const timer = setTimeout(() => {
      inFlight.delete(seq);
      ackTimers.delete(seq);
      deadAcks++;
    }, FLOW.ackTimeoutMs);
    ackTimers.set(seq, timer);
    return true;
  };

  const pump = async (myGen, mySession) => {
    while (streamGen === myGen) {
      const waitFrom = Date.now();
      while (inFlight.size >= FLOW.ackWindow && streamGen === myGen) {
        await new Promise((r) => setTimeout(r, FLOW.ackPollMs));
      }
      blockedMs += Date.now() - waitFrom;
      if (streamGen !== myGen) break;
      while (paused && streamGen === myGen) {
        await new Promise((r) => setTimeout(r, FLOW.pausePollMs));
      }
      if (streamGen !== myGen) break;
      if (deadAcks >= FLOW.deadAckLimit) {
        logger.info("📱 No acks — viewer gone, stopping stream");
        protocol.emit("mobile:ended", {});
        stop();
        return;
      }
      if (await adapt(myGen)) return;
      const frame = await mySession.readFrame();
      if (!frame || streamGen !== myGen) break;
      if (!sendFrame(frame) && !frame.isKey) mySession.requestKeyframe();
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
    const ratio = blockedMs / (now - sampleStart);
    blockedMs = 0;
    sampleStart = now;

    if (!requested || now - lastRestartAt < ADAPT.minRestartGapMs) return false;
    let next = scale;
    if (ratio > ADAPT.congestedRatio) next = Math.max(ADAPT.minScale, scale * ADAPT.stepDown);
    else if (ratio < ADAPT.healthyRatio) next = Math.min(ADAPT.maxScale, scale * ADAPT.stepUp);
    if (Math.abs(next - scale) < 0.05) return false;

    scale = next;
    lastRestartAt = now;
    const serial = activeSerial;
    logger.info(`📱 Link ${(ratio * 100).toFixed(0)}% blocked → stream at ${(scale * 100).toFixed(0)}%`);
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

  socket.on("mobile:deviceCount", async (data, cb) => {
    const respond = typeof data === "function" ? data : cb;
    let count = 0;
    try { count = (await listSerialsAsync()).length; } catch { count = 0; }
    respond?.({ count, available: isAvailable() });
  });

  socket.on("mobile:list", handle(async () => ({
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

  socket.on("mobile:sdkInstall", handle(async (data) => {
    const result = await installComponent(data?.component);
    watchDevices();
    return result;
  }));

  socket.on("mobile:sdkCancel", handle(async () => {
    setCancelled(true);
    return { cancelled: cancelInstall() };
  }));

  socket.on("mobile:sdkStatus", handle(async () => ({ env: await envStatus() })));

  socket.on("mobile:provisionPresets", handle(async () => ({ presets: listProvisionPresets() })));

  socket.on("mobile:provision", handle(async (data) => {
    const result = await provisionPreset(data?.presetId, {
      onStep: (label) => endJob({ step: label })
    });
    watchDevices();
    return result;
  }));

  socket.on("mobile:imageList", handle(async () => ({
    images: await listImages(),
    installed: listInstalledImages(),
    hostAbi: hostAbi()
  })));

  socket.on("mobile:imageInstall", handle(async (data) => {
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

  socket.on("mobile:imageUninstall", handle(async (data) => {
    const result = await uninstallImage(data?.imagePath);
    watchDevices();
    return result;
  }));

  socket.on("mobile:deviceProfiles", handle(async () => ({ profiles: await listDeviceProfiles() })));

  socket.on("mobile:avdCreate", handle(async (data) => {
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

  socket.on("mobile:avdDelete", handle(async (data) => {
    const avdName = data?.avdName;
    await assertStopped(avdName);
    return deleteAvd(avdName);
  }));

  socket.on("mobile:avdWipe", handle(async (data) => {
    const avdName = data?.avdName;
    await assertStopped(avdName);
    return wipeAvdData(avdName);
  }));

  socket.on("mobile:avdList", handle(async () => ({ avds: await listAvdsAsync() })));

  socket.on("mobile:avdStart", handle(async (data) => {
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

  socket.on("mobile:avdStop", handle(async (data) => {
    const serial = withSerial(data);
    if (activeSerial === serial) { stop(); stopLogcat(); }
    const stopped = await stopAvd(serial);
    watchDevices();
    return { stopped };
  }));

  socket.on("mobile:apps", handle(async (data) => {
    const serial = withSerial(data);
    const [apps, foreground] = await Promise.all([listApps(serial), foregroundApp(serial)]);
    return { apps, foreground };
  }));

  socket.on("mobile:launch", handle(async (data) => {
    launchApp(withSerial(data), data?.packageName);
    return {};
  }));

  socket.on("mobile:stopApp", handle(async (data) => {
    stopApp(withSerial(data), data?.packageName);
    return {};
  }));

  socket.on("mobile:clearApp", handle(async (data) => {
    clearAppData(withSerial(data), data?.packageName);
    return {};
  }));

  socket.on("mobile:uninstall", handle(async (data) => {
    uninstallApp(withSerial(data), data?.packageName);
    return {};
  }));

  socket.on("mobile:openLink", handle(async (data) => {
    openDeepLink(withSerial(data), data?.url);
    return {};
  }));

  socket.on("mobile:rotate", handle(async (data) => {
    const serial = withSerial(data);
    setRotation(serial, data?.rotation);
    return { rotation: getRotation(serial) };
  }));

  socket.on("mobile:screenshot", handle(async (data) => ({
    png: screenshot(withSerial(data)).toString("base64")
  })));

  socket.on("mobile:apkStage", handle(async (data) => {
    assertApkSize(data?.size);
    const fileName = path.basename(stagePathFor(data?.name));
    return { targetDir: stageDir(), fileName };
  }));

  socket.on("mobile:install", handle(async (data) => {
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

  socket.on("mobile:logcatStart", handle(async (data) => {
    const serial = withSerial(data);
    stopLogcat();
    const opts = { ...data };
    if (!("packageName" in opts)) opts.packageName = (await foregroundApp(serial))?.packageName || null;
    logcat = new LogcatStream(serial, opts, (lines) => protocol.emit("mobile:logcat", { lines })).start();
    return { packageName: opts.packageName };
  }));

  socket.on("mobile:logcatFilter", handle(async (data) => {
    if (!logcat) throw new Error("Logcat not running");
    logcat.setFilter(data);
    return {};
  }));

  socket.on("mobile:logcatStop", () => stopLogcat());

  socket.on("mobile:start", async (data, cb) => {
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
      maySleep = await isAgentStarted(serial);
      frameSeq = 0;
      requested = data?.options || {};
      paused = false;
      scale = 1;
      blockedMs = 0;
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

  socket.on("mobile:stop", () => stop());

  socket.on("mobile:input", (data) => {
    session?.input(data);
  });

  socket.on("mobile:ack", (data) => {
    const seq = data?.seq;
    if (!Number.isFinite(seq)) return;
    deadAcks = 0;
    for (const pending of [...inFlight]) {
      if (pending > seq) continue;
      inFlight.delete(pending);
      const timer = ackTimers.get(pending);
      if (timer) { clearTimeout(timer); ackTimers.delete(pending); }
    }
  });

  socket.on("mobile:visible", (data) => {
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

  socket.on("mobile:keyframe", () => {
    session?.requestKeyframe();
  });

  socket.on("disconnect", () => { stop(); stopLogcat(); clearInterval(deviceWatch); removeJobListener(); });
}
