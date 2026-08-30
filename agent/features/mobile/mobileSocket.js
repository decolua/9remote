// Android mirroring handlers — one scrcpy session per socket, streamed over the
// shared transport bus (RTC-first, WS tunnel fallback) like every other feature.

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

// Shrink an option set by `scale`. Bitrate follows the pixel count rather than
// the edge, so quality per pixel is what stays constant — a smaller frame at a
// proportionally smaller bitrate looks the same, just smaller.
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

// The feature is always offered: a host with no tooling shows the setup card
// and can install what it needs. Hiding the entry would leave that host with
// no way in. Whether adb itself is present rides along in mobile:list env.
export function isMobileAvailable() {
  return true;
}

export function setupMobileHandlers(socket) {
  const protocol = socket.data.protocol;
  if (!protocol) return;

  let session = null;
  let logcat = null;
  // Serial the client is currently working with — every app/log call is scoped
  // to it, so the client never repeats it.
  let activeSerial = null;
  let frameSeq = 0;
  // Bumped on every start/stop so a pump parked in readFrame() self-exits instead
  // of waking up against whatever session replaced its own.
  let streamGen = 0;

  // Frames sent but not yet acknowledged by the client. See FLOW.
  let inFlight = new Set();
  let ackTimers = new Map();
  // Frames that expired without an ack, in a row. Reset by any ack.
  let deadAcks = 0;
  // Viewer hid the tab: hold the pump instead of encoding for a hidden canvas.
  let paused = false;
  // Only AVDs this agent started may be put to sleep — blanking the screen of
  // someone's physical phone would be an unpleasant surprise.
  let maySleep = false;
  let sleepTimer = null;
  const cancelSleepTimer = () => { clearTimeout(sleepTimer); sleepTimer = null; };

  const clearFlow = () => {
    for (const timer of ackTimers.values()) clearTimeout(timer);
    ackTimers.clear();
    inFlight.clear();
    deadAcks = 0;
  };

  // Tear down the video stream but stay on the device. Used when the encoder is
  // restarted at a new size: the device has not changed, so an app or input
  // command arriving mid-restart must still find its target.
  const stopStream = () => {
    streamGen++;
    session?.close();
    session = null;
    clearFlow();
  };

  const stop = () => {
    stopStream();
    cancelSleepTimer();
    // Nobody is watching any more, so blank the screen straight away: an awake
    // emulator idles around four times the host CPU of a sleeping one, and
    // waking it again costs well under a second.
    if (maySleep && activeSerial) sleepDevice(activeSerial);
    maySleep = false;
    // Also forget the device: an app command arriving after this must not
    // silently act on the one the user just left.
    activeSerial = null;
  };

  const stopLogcat = () => { logcat?.close(); logcat = null; };

  // What the client asked for, and how much of it the link turned out to carry.
  let requested = null;
  let scale = 1;
  let blockedMs = 0;        // time the pump spent waiting on the ack window
  let sampleStart = 0;
  let lastRestartAt = 0;

  // One access unit → N ordered chunks. Backpressure drops the whole frame:
  // a partial access unit is undecodable, and the next keyframe recovers.
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
    // Track for flow control; released by mobile:ack, or by the timeout below
    // so a lost ack can never stall the stream permanently.
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
      // Wait for the client to catch up before pulling another frame. Reading
      // at encoder speed while the tunnel drains slower is what turns a slow
      // link into an ever-growing backlog rather than a lower frame rate.
      const waitFrom = Date.now();
      while (inFlight.size >= FLOW.ackWindow && streamGen === myGen) {
        await new Promise((r) => setTimeout(r, FLOW.ackPollMs));
      }
      blockedMs += Date.now() - waitFrom;
      if (streamGen !== myGen) break;
      // Hold here while hidden. readFrame() is not called, so scrcpy's socket
      // backs up and the encoder throttles itself — no frames, no bandwidth.
      while (paused && streamGen === myGen) {
        await new Promise((r) => setTimeout(r, FLOW.pausePollMs));
      }
      if (streamGen !== myGen) break;
      // Nobody has acknowledged anything for a long stretch: the viewer is gone
      // even though no stop arrived. Encoding for no one costs the host's CPU.
      if (deadAcks >= FLOW.deadAckLimit) {
        logger.info("📱 No acks — viewer gone, stopping stream");
        protocol.emit("mobile:ended", {});
        stop();
        return;
      }
      if (await adapt(myGen)) return;   // restarted at a new size; a fresh pump took over
      const frame = await mySession.readFrame();
      if (!frame || streamGen !== myGen) break;
      // Dropped on backpressure — ask for a keyframe so the client re-syncs
      // instead of decoding against a gap.
      if (!sendFrame(frame) && !frame.isKey) mySession.requestKeyframe();
    }
    // Only the live pump reports the end; a superseded one exits quietly.
    if (streamGen !== myGen) return;
    protocol.emit("mobile:ended", {});
    stop();
  };

  // Running-device count, pushed on change. Headless emulators have no window,
  // so without this the user cannot tell from the app whether one is up — and
  // polling from the client only works while the mirror panel is open.
  let lastDeviceCount = -1;
  // Async: this fires every few seconds forever, and the sync form froze the
  // whole agent for ~80ms each time — long enough to stall video and input.
  // `available` rides along so the client can hide the button entirely on a host
  // with no Android tooling, rather than offering one that can never work.
  const watchDevices = async () => {
    let count = 0;
    try { count = (await listSerialsAsync()).length; } catch { count = 0; }
    if (count === lastDeviceCount) return;
    lastDeviceCount = count;
    protocol.emit("mobile:devicesChanged", { count, available: isAvailable() });
  };
  watchDevices();
  const deviceWatch = setInterval(watchDevices, DEVICE_WATCH_MS);

  // Every ack goes through here so a thrown adb error becomes {success:false}
  // instead of an unhandled rejection in the socket handler.
  const handle = (fn) => async (data, cb) => {
    const respond = typeof data === "function" ? data : cb;
    try {
      const result = await fn(typeof data === "function" ? {} : (data || {}));
      respond?.({ success: true, ...result });
    } catch (err) {
      respond?.({ success: false, error: err.message });
    }
  };

  // Calls that need a device: default to the active one so the client can omit it.
  const withSerial = (data) => {
    const serial = data?.serial || activeSerial;
    if (!serial) throw new Error("No device selected");
    return serial;
  };

  /**
   * Resize the stream to what the link is actually carrying. Returns true when
   * the session was restarted, so the caller's pump must stand down.
   *
   * The signal is how long the pump sat blocked on the ack window: that only
   * grows when the client cannot keep up, and unlike a byte counter it needs no
   * assumption about what the link "should" do.
   */
  const adapt = async (myGen) => {
    // A pump that woke from an await after being superseded must not resize —
    // it would tear down the session that replaced it. Same guard the pump
    // itself uses; without it the generation counter buys nothing here.
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
    // Ignore changes too small to be worth a visible restart.
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
      // frameSeq deliberately keeps counting: the client's ack cursor only ever
      // moves forward, so restarting at 0 would make every ack look stale and
      // stall the pump on the ack timeout instead.
      sampleStart = Date.now();
      // Announce before pumping: the canvas is sized from meta, so frames that
      // arrive first would paint into a canvas of the old dimensions.
      protocol.emit("mobile:resized", { meta });
      pump(myNewGen, mySession);
    } catch (err) {
      logger.error(`adapt restart failed: ${err.message}`);
      protocol.emit("mobile:ended", {});
    }
    return true;
  };

  // A client mounting after the initial push has missed it, and the watcher only
  // emits on change — so it must be able to ask for the current value.
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

  // ── SDK setup (install missing tooling on an explicit user click) ─────────

  // Progress reaches the client as events; the ack only lands when the whole
  // install does. Same shape as avdStart: close the panel freely, the job runs
  // on the agent.
  const pushJob = () => {
    const state = sdkJobState();
    if (state) protocol.emit("mobile:sdkProgress", state);
  };

  // One listener per connection; the set in sdkSetup multicasts to all of
  // them, and a disconnect removes only this one.
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

  // ── One-tap device provisioning ─────────────────────────────────────────────
  // The whole setup chain (missing tools → image → AVD) behind one pick. Each
  // internal step still drives the shared job slot, so progress/cancel behave
  // exactly like a direct component install.

  socket.on("mobile:provisionPresets", handle(async () => ({ presets: listProvisionPresets() })));

  socket.on("mobile:provision", handle(async (data) => {
    const result = await provisionPreset(data?.presetId, {
      onStep: (label) => endJob({ step: label })
    });
    watchDevices();
    return result;
  }));

  // ── System images (sdkmanager) ─────────────────────────────────────────────

  socket.on("mobile:imageList", handle(async () => ({
    images: await listImages(),
    installed: listInstalledImages(),
    hostAbi: hostAbi()
  })));

  // Downloads run as the single SDK job so the setup card's spinner, cancel
  // and re-attach semantics apply unchanged; percent comes from sdkmanager.
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

  // ── AVD management (avdmanager) ────────────────────────────────────────────

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

  // Refused for a running AVD: deleting or wiping the image under a live
  // emulator corrupts it. The client checks state, the agent enforces it.
  // A running emulator is asked its AVD name directly — the device list does
  // not carry it, and the ini file would say "running" for a half-dead one.
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

  // ── Emulator lifecycle ───────────────────────────────────────────────────

  socket.on("mobile:avdList", handle(async () => ({ avds: await listAvdsAsync() })));

  socket.on("mobile:avdStart", handle(async (data) => {
    const avdName = data?.avdName;
    if (!avdName) throw new Error("avdName required");
    // Boot takes ~20-60s; stream the phase so the UI shows progress rather
    // than a spinner with no end in sight.
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
    // Tearing down the display first — the stream is about to die anyway.
    if (activeSerial === serial) { stop(); stopLogcat(); }
    const stopped = await stopAvd(serial);
    watchDevices();
    return { stopped };
  }));

  // ── Apps ─────────────────────────────────────────────────────────────────

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

  // ── APK install ──────────────────────────────────────────────────────────
  // The APK arrives through the existing file-upload pipeline (fileExplorer)
  // into a temp dir, then this installs from that path and deletes it.

  // The client uploads the APK through the normal file pipeline into this dir
  // (it jails writes to targetDir), then calls mobile:install with the result.
  socket.on("mobile:apkStage", handle(async (data) => {
    assertApkSize(data?.size);
    const fileName = path.basename(stagePathFor(data?.name));
    return { targetDir: stageDir(), fileName };
  }));

  socket.on("mobile:install", handle(async (data) => {
    // The client sends only the staged file NAME; the agent joins it to its own
    // staging dir. Accepting a full path would both trust the client and break
    // on Windows, where the two sides disagree about the separator.
    const fileName = path.basename(String(data?.fileName || ""));
    const apkPath = path.join(stageDir(), fileName);
    if (!fileName || !fileName.toLowerCase().endsWith(".apk") || !fs.existsSync(apkPath)) {
      throw new Error("APK must be staged first");
    }
    try {
      const { packageName } = installApk(withSerial(data), apkPath);
      // Launching right after install is what the user wanted anyway.
      if (packageName && data?.launch !== false) {
        try { launchApp(withSerial(data), packageName); } catch { /* no launcher activity */ }
      }
      return { packageName };
    } finally {
      cleanupStaged(apkPath);
    }
  }));

  // ── Logcat ───────────────────────────────────────────────────────────────

  socket.on("mobile:logcatStart", handle(async (data) => {
    const serial = withSerial(data);
    stopLogcat();
    // No package named yet (the client is still fetching the app list): scope to
    // the foreground app here, so the opening moments are not an unfiltered
    // firehose down the tunnel. An explicit "" means the user asked for all apps.
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
      // Wake first: the device may have been put to sleep when the last viewer
      // left, and the first frames would otherwise show a black screen.
      await wakeDevice(serial);
      const mySession = new ScrcpySession(serial);
      const myGen = streamGen;
      const meta = await mySession.start(data?.options || {});
      // A stop or a newer start landed while we were awaiting — this session is
      // already obsolete, so drop it rather than publish it as the live one.
      if (streamGen !== myGen) {
        mySession.close();
        return cb?.({ success: false, error: "superseded" });
      }
      session = mySession;
      activeSerial = serial;
      // Resolved once per session rather than per teardown: stop() must not wait
      // on adb to decide whether it is allowed to blank the screen.
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

  // Client painted everything up to `seq` — release those frames and any older
  // ones, since the channel is ordered.
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

  // The viewer hid the tab (or locked the screen). Explicit, unlike inferring it
  // from missing acks: pausing here stops the encoder rather than filling a
  // tunnel nobody is watching.
  socket.on("mobile:visible", (data) => {
    const visible = data?.visible !== false;
    if (visible === !paused) return;
    paused = !visible;
    if (!paused) {
      // Back already — cancel a pending sleep, and wake if it beat us to it.
      cancelSleepTimer();
      if (maySleep && activeSerial) wakeDevice(activeSerial);
      return;
    }
    logger.info("📱 Viewer hidden — pausing stream");
    // Grace period, unlike a closed stream: flicking to another tab and back is
    // a few seconds, and blanking the screen for that is worse than the CPU it
    // would save.
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
