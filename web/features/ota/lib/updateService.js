// OTA update service — resolve/publish/promote against D1, with a KV cache
// fronting the manifest read path. KV holds the signed payload so a cache hit
// serves without touching D1.
import { buildSignedManifest } from "./manifest.js";
import { KV_CACHE_TTL_SECONDS } from "../constants/index.js";

const PLATFORMS = ["ios", "android"];

// KV key for a (channel, runtimeVersion, platform) tuple.
// Must be deterministic and collision-free across platforms.
export function cacheKeyFor({ channel, runtimeVersion, platform }) {
  return `ota:${channel}:${runtimeVersion}:${platform}`;
}

// Single source of truth for "what is the active update for this channel?"
// KV first (hot path), D1 fallback, then warm KV. Returns null when nothing
// is published or the pointed-at row was archived.
export async function resolveActiveUpdate(env, { channel, runtimeVersion, platform }) {
  const key = cacheKeyFor({ channel, runtimeVersion, platform });
  const cached = await env.OTA_KV.get(key, "json");
  if (cached && cached.status === "active") return cached;

  const pointer = await env.DB.prepare(
    "SELECT currentUpdateGroupId FROM otaChannelPointer WHERE channel = ? AND runtimeVersion = ? AND platform = ?"
  ).bind(channel, runtimeVersion, platform).first();

  if (!pointer || !pointer.currentUpdateGroupId) return null;

  const row = await env.DB.prepare(
    "SELECT * FROM otaUpdateGroup WHERE id = ?"
  ).bind(pointer.currentUpdateGroupId).first();

  if (!row || row.status !== "active") return null;

  const parsed = parseRow(row);
  await env.OTA_KV.put(key, JSON.stringify(parsed), { expirationTtl: KV_CACHE_TTL_SECONDS });
  return parsed;
}

// Publish a freshly uploaded update: persist, sign, archive prior rows for the
// same (channel,runtime,platform), and point the channel at the new row.
export async function publishUpdate(env, payload) {
  validatePayload(payload);

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const draft = {
    id,
    runtimeVersion: payload.runtimeVersion,
    platform: payload.platform,
    channel: payload.channel,
    launchAssetKey: payload.launchAssetKey,
    assets: payload.assets,
    expoConfig: payload.expoConfig || {},
    createdAt
  };

  const { manifestString, signature } = await buildSignedManifest(
    draft, env.R2_PUBLIC_BASE, env.OTA_SIGNING_PRIVATE_KEY, env.OTA_SIGNING_KEY_ID
  );

  const buildNumber = await nextBuildNumber(env);
  const manifestJson = JSON.parse(manifestString);

  await env.DB.prepare(
    `INSERT INTO otaUpdateGroup
      (id, buildNumber, runtimeVersion, platform, channel, message, launchAssetKey, assets, expoConfig, manifestJson, manifestString, signature, status, publishedBy, publishedAt, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, buildNumber, payload.runtimeVersion, payload.platform, payload.channel,
    payload.message || "", payload.launchAssetKey,
    JSON.stringify(payload.assets), JSON.stringify(payload.expoConfig || {}),
    JSON.stringify(manifestJson), manifestString, signature, "active",
    payload.publishedBy || "", createdAt, createdAt
  ).run();

  // Keep a single active build per (channel,runtime,platform) to avoid update loops
  await archiveOthers(env, payload, id);
  await pointChannel(env, payload, id, createdAt);
  await invalidate(env, payload);

  return {
    id, buildNumber, ...draft,
    manifestString, signature,
    message: payload.message || "",
    publishedBy: payload.publishedBy || "",
    publishedAt: createdAt
  };
}

// Republish an existing update as a brand-new row (new id + createdAt) reusing
// the old assets. Clients reject an id they have already seen, so rollback via
// id-reuse is a silent no-op and can loop the updater.
export async function promoteUpdate(env, sourceId) {
  const source = await env.DB.prepare("SELECT * FROM otaUpdateGroup WHERE id = ?").bind(sourceId).first();
  if (!source) throw new Error("Update not found");

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const target = {
    runtimeVersion: source.runtimeVersion,
    platform: source.platform,
    channel: source.channel
  };

  const draft = {
    id,
    runtimeVersion: source.runtimeVersion,
    platform: source.platform,
    channel: source.channel,
    launchAssetKey: source.launchAssetKey,
    assets: JSON.parse(source.assets),
    expoConfig: JSON.parse(source.expoConfig || "{}"),
    createdAt
  };

  const { manifestString, signature } = await buildSignedManifest(
    draft, env.R2_PUBLIC_BASE, env.OTA_SIGNING_PRIVATE_KEY, env.OTA_SIGNING_KEY_ID
  );

  const buildNumber = await nextBuildNumber(env);
  const manifestJson = JSON.parse(manifestString);

  await env.DB.prepare(
    `INSERT INTO otaUpdateGroup
      (id, buildNumber, runtimeVersion, platform, channel, message, launchAssetKey, assets, expoConfig, manifestJson, manifestString, signature, status, publishedBy, publishedAt, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, buildNumber, source.runtimeVersion, source.platform, source.channel,
    `Republish #${source.buildNumber || 0}`, source.launchAssetKey,
    source.assets, source.expoConfig,
    JSON.stringify(manifestJson), manifestString, signature, "active",
    source.publishedBy || "", source.publishedAt || createdAt, createdAt
  ).run();

  await archiveOthers(env, target, id);
  await pointChannel(env, target, id, createdAt);
  await invalidate(env, target);

  return {
    id, buildNumber, ...draft,
    manifestString, signature,
    message: `Republish #${source.buildNumber || 0}`,
    publishedBy: source.publishedBy || "",
    publishedAt: source.publishedAt || createdAt
  };
}

function validatePayload(p) {
  if (!p) throw new Error("Missing payload");
  if (!p.runtimeVersion) throw new Error("Missing runtimeVersion");
  if (!PLATFORMS.includes(p.platform)) throw new Error(`Invalid platform: ${p.platform}`);
  if (!p.channel) throw new Error("Missing channel");
  if (!p.launchAssetKey) throw new Error("Missing launchAssetKey");
  if (!Array.isArray(p.assets)) throw new Error("Missing assets");
}

async function nextBuildNumber(env) {
  const row = await env.DB.prepare(
    "SELECT buildNumber FROM otaUpdateGroup ORDER BY buildNumber DESC LIMIT 1"
  ).first();
  return (row?.buildNumber || 0) + 1;
}

async function archiveOthers(env, { channel, runtimeVersion, platform }, keepId) {
  await env.DB.prepare(
    "UPDATE otaUpdateGroup SET status = ? WHERE channel = ? AND runtimeVersion = ? AND platform = ? AND id != ?"
  ).bind("archived", channel, runtimeVersion, platform, keepId).run();
}

// Atomic upsert — the PK is (channel,runtimeVersion,platform), so a replace
// swaps the pointer in one statement. A delete+insert pair could crash between
// the two and leave the channel with no pointer (clients see "no update").
async function pointChannel(env, { channel, runtimeVersion, platform }, id, updatedAt) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO otaChannelPointer (channel, runtimeVersion, platform, currentUpdateGroupId, updatedAt)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(channel, runtimeVersion, platform, id, updatedAt).run();
}

async function invalidate(env, { channel, runtimeVersion, platform }) {
  await env.OTA_KV.delete(cacheKeyFor({ channel, runtimeVersion, platform }));
}

// D1 stores assets/expoConfig/manifestJson as TEXT; parse them back out.
export function parseRow(row) {
  return {
    ...row,
    assets: safeJson(row.assets, []),
    expoConfig: safeJson(row.expoConfig, {}),
    manifestJson: safeJson(row.manifestJson, {}),
    manifestString: row.manifestString || "",
    signature: row.signature || ""
  };
}

function safeJson(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}
