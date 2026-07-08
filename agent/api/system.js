// System stats — agent process + OS + remote desktop metrics
import os from "os";
import { REMOTE_CONFIG } from "../features/remote/REMOTE_CONFIG.js";
import { isRemoteAvailable, getResourceManager } from "../features/remote/remoteSocket.js";
import { jsonOk, jsonErr } from "../lib/router.js";

function getRemoteClients() {
  const rm = getResourceManager();
  if (!rm?.activeClients) return { total: 0, streaming: 0 };
  let streaming = 0;
  for (const c of rm.activeClients.values()) if (c.isStreaming) streaming++;
  return { total: rm.activeClients.size, streaming };
}

export function getSystemStats() {
  const mem = process.memoryUsage();
  const cpus = os.cpus();
  const stats = {
    agent: {
      pid: process.pid,
      version: typeof __CLI_VERSION__ !== "undefined" ? __CLI_VERSION__ : null,
      nodeVersion: process.version,
      platform: `${process.platform}/${process.arch}`,
      uptimeSec: Math.round(process.uptime()),
      memory: {
        heapUsedMB: Math.round((mem.heapUsed / 1048576) * 10) / 10,
        heapTotalMB: Math.round((mem.heapTotal / 1048576) * 10) / 10,
        rssMB: Math.round((mem.rss / 1048576) * 10) / 10,
        externalMB: Math.round((mem.external / 1048576) * 10) / 10,
      },
    },
    os: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      uptimeSec: Math.round(os.uptime()),
      loadAvg: os.loadavg(),
      cpuModel: cpus?.[0]?.model || "unknown",
      cpuCount: cpus.length,
      totalMemMB: Math.round(os.totalmem() / 1048576),
      freeMemMB: Math.round(os.freemem() / 1048576),
    },
    remote: {
      available: isRemoteAvailable(),
      ...getRemoteClients(),
      memoryWarningThresholdMB: REMOTE_CONFIG.resourceManagement.memoryWarningThreshold,
    },
    timestamp: Date.now(),
  };
  return stats;
}

export function handleSystemStats(req, res) {
  try {
    jsonOk(res, getSystemStats());
  } catch (err) {
    jsonErr(res, 500, "stats error", err.message);
  }
}
