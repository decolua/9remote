// D1-backed login hardening: escalating per-IP lockout, per-account delay, and
// an audit log of every attempt. rateLimit.js still runs first inside the
// isolate; these rows are the durable layer an IP-hopping attacker cannot reset
// by landing on a fresh edge location.
//
// Keys are 'ip:<addr>' (locks — an attacker only ever locks their own IP) and
// 'user:<name>' (counts only, drives the delay — a hard account lock would let
// anyone DoS the operator out of their own console).

import { withD1Retry } from "@/shared/utils/db";
import {
  ADMIN_LOGIN_LOCKS,
  ADMIN_LOGIN_DELAY_AFTER_FAILS,
  ADMIN_LOGIN_DELAY_MAX_MS
} from "../constants/index.js";

// datetime('now') emits "YYYY-MM-DD HH:MM:SS"; the repo-wide convention for
// reading those back as UTC is appending "Z" (see SessionTable.isOnline).
function toMs(sqlite) {
  const t = new Date(String(sqlite) + "Z").getTime();
  return Number.isFinite(t) ? t : 0;
}

export function userLockKey(username) {
  return `user:${String(username).toLowerCase().slice(0, 64)}`;
}

export function ipLockKey(ip) {
  return `ip:${String(ip).slice(0, 64)}`;
}

/** Milliseconds the current attempt must sleep for this many account failures. */
export function delayMsFor(userFails) {
  if (userFails < ADMIN_LOGIN_DELAY_AFTER_FAILS) return 0;
  const steps = Math.min(userFails - ADMIN_LOGIN_DELAY_AFTER_FAILS, 4);
  return Math.min(1000 * 2 ** steps, ADMIN_LOGIN_DELAY_MAX_MS);
}

/**
 * @returns {Promise<{locked: boolean, retryAfterSec: number, userFails: number}>}
 */
export async function checkLoginGuard(env, ip, username) {
  const { results } = await withD1Retry(() => env.DB.prepare(
    "SELECT key, fails, lockedUntil FROM adminLoginLocks WHERE key IN (?, ?)"
  ).bind(ipLockKey(ip), userLockKey(username)).all());

  const now = Date.now();
  let lockedUntilMs = 0;
  let userFails = 0;
  for (const row of results || []) {
    if (row.lockedUntil) lockedUntilMs = Math.max(lockedUntilMs, toMs(row.lockedUntil));
    if (row.key === userLockKey(username)) userFails = row.fails || 0;
  }
  return {
    locked: lockedUntilMs > now,
    retryAfterSec: Math.max(0, Math.ceil((lockedUntilMs - now) / 1000)),
    userFails
  };
}

// Atomic upsert so concurrent attempts can't undercount. The lock CASE is
// generated from ADMIN_LOGIN_LOCKS (descending) so thresholds live in one place.
const LOCK_CASE = ADMIN_LOGIN_LOCKS
  .map((t) => `WHEN adminLoginLocks.fails + 1 >= ${t.fails} THEN datetime('now', '+${t.minutes} minutes')`)
  .join(" ");

async function bumpKey(env, key, withLock) {
  await withD1Retry(() => env.DB.prepare(`
    INSERT INTO adminLoginLocks (key, fails, updatedAt) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
      fails = adminLoginLocks.fails + 1,${withLock ? `
      lockedUntil = CASE ${LOCK_CASE} END,` : ""}
      updatedAt = excluded.updatedAt
  `).bind(key, new Date().toISOString()).run());
}

export async function recordLoginFailure(env, ip, username) {
  await bumpKey(env, ipLockKey(ip), true);
  await bumpKey(env, userLockKey(username), false);
}

// A correct password wipes both dimensions: a few typos before success leave
// no trace, exactly like the in-memory counter.
export async function clearLoginFailures(env, ip, username) {
  await withD1Retry(() => env.DB.prepare(
    "DELETE FROM adminLoginLocks WHERE key IN (?, ?)"
  ).bind(ipLockKey(ip), userLockKey(username)).run());
}

export async function logLoginAttempt(env, { username, ip, ok, reason }) {
  await withD1Retry(() => env.DB.prepare(
    "INSERT INTO adminLoginLog (username, ip, ok, reason) VALUES (?, ?, ?, ?)"
  ).bind(String(username).slice(0, 64), String(ip).slice(0, 64), ok ? 1 : 0, reason).run());
}
