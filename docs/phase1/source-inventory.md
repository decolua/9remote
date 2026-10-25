# 上游源码与 Cloudflare 检索清单

基线：`29ff890d6c96b60996fd2e4a9331c00198556ed6`。检索命中不等于运行时依赖；测试、说明和静态文案也包含在内。

## 目录文件数

- `.easignore`：1
- `.gitignore`：1
- `CLAUDE.md`：1
- `LICENSE`：1
- `README.md`：1
- `app.json`：1
- `desktop`：89
- `eas.json`：1
- `eslint.config.mjs`：1
- `gitbook`：38
- `host`：453
- `package.json`：1
- `scripts`：8
- `web`：922

## Cloudflare / 官方服务引用

```text
web/scripts/injectSignalingDO.mjs:2:// Runs AFTER `opennextjs-cloudflare build`. Idempotent. Inlines the DO class +
web/scripts/injectSignalingDO.mjs:20:  .replace(/^import\s*\{[^}]*DurableObject[^}]*\}\s*from\s*["']cloudflare:workers["'];?\s*/m, "")
web/scripts/injectSignalingDO.mjs:29:// 1. Shared cloudflare:workers import near the top.
web/scripts/injectSignalingDO.mjs:32:import { DurableObject } from "cloudflare:workers";
web/scripts/injectHotRoutes.mjs:2:// Runs AFTER `opennextjs-cloudflare build` (and after injectSignalingDO.mjs —
web/features/admin/components/TurnstileWidget.js:32:      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
web/features/admin/lib/turnstile.js:16:    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
web/features/admin/lib/turnKeys.js:10:// Hosts that count as the dev environment. The prod worker allows dev.9remote.cc
web/features/admin/lib/turnKeys.js:20:export const TURN_DASHBOARD_URL = "https://dash.cloudflare.com/?to=/:account/realtime/turn";
web/features/admin/lib/turnKeys.js:22:const TURN_API = "https://rtc.live.cloudflare.com/v1/turn/keys";
web/features/admin/lib/guard.js:1:import { getCloudflareContext } from "@opennextjs/cloudflare";
web/features/admin/lib/guard.js:7:  const { env } = getCloudflareContext();
web/features/session/components/AgentDashboardView.js:889:              <ConnectCard icon="language" iconClass="ad-tile-web" title="Web" sub="9remote.cc" href={LOGIN_URL} />
web/features/landing/components/Footer.js:17:  { href: "https://docs.9remote.cc/", label: "Documentation" },
web/features/landing/components/Navbar.js:13:  { href: "https://docs.9remote.cc/", label: "Docs", external: true },
web/features/ai/components/modals/SkillsModal.jsx:42:            placeholder="Search skills (e.g. cloudflare, review, deploy)..."
host/features/terminal/pushManager.js:40:  webpush.setVapidDetails("mailto:admin@9remote.cc", keys.publicKey, keys.privateKey);
web/features/ota/constants/index.js:12:// The bucket itself is served from a subdomain (e.g. r2.9remote.cc), not read
web/features/ota/constants/index.js:14:export const R2_DEFAULT_BASE = "https://r2.9remote.cc";
host/test/aiMcpServers.test.mjs:56:  'url = "https://9remote.cc/mcp"',
host/test/originGuard.test.mjs:77:  assert.equal(corsOriginFor("https://9remote.cc", true), "https://9remote.cc");
host/test/originGuard.test.mjs:78:  assert.equal(corsOriginFor("https://dev.9remote.cc", true), "https://dev.9remote.cc");
host/test/tunnelEdgeWatchdog.test.mjs:110:test("a healthy cloudflared is never killed, however bad our probe looks", () => {
host/test/tunnelEdgeWatchdog.test.mjs:152:    20241: { readyConnections: 4, host: "other.trycloudflare.com" },
host/test/tunnelEdgeWatchdog.test.mjs:155:  assert.equal(lookup.query("https://ours.trycloudflare.com"), null,
host/test/tunnelEdgeWatchdog.test.mjs:161:    20241: { readyConnections: 4, host: "other.trycloudflare.com" },
host/test/tunnelEdgeWatchdog.test.mjs:162:    20243: { readyConnections: 2, host: "ours.trycloudflare.com" },
host/test/tunnelEdgeWatchdog.test.mjs:165:  assert.equal(lookup.query("https://ours.trycloudflare.com"), 2);
host/test/tunnelEdgeWatchdog.test.mjs:180:  assert.equal(lookup.query("https://ours.trycloudflare.com"), 3);
host/test/tunnelEdgeWatchdog.test.mjs:186:  assert.equal(hasLiveTunnel("https://x.trycloudflare.com", null, false), false);
host/test/tunnelEdgeWatchdog.test.mjs:190:  assert.equal(hasLiveTunnel("https://x.trycloudflare.com", 123, false), false);
host/test/tunnelEdgeWatchdog.test.mjs:194:  assert.equal(hasLiveTunnel("https://x.trycloudflare.com", 123, true), true);
host/test/routerOrigin.test.mjs:67:  const res = await call("/api/health", { origin: "https://9remote.cc" });
host/test/routerOrigin.test.mjs:69:  assert.equal(res.headers.get("access-control-allow-origin"), "https://9remote.cc");
host/test/routerOrigin.test.mjs:74:    ["/api/health", "https://9remote.cc"],
host/test/tunnelSweep.test.mjs:1:// Stale-tunnel sweep: a 9remote start must not leave a previous cloudflared
host/test/tunnelSweep.test.mjs:3:// trycloudflare slot, so leftovers are what starve the next start of quota
host/test/tunnelSweep.test.mjs:4:// (observed: a day-old cloudflared from a dead instance still alive, the pid
host/test/tunnelSweep.test.mjs:9:// because a user's own `cloudflared` (brew, a named tunnel for another service)
host/test/tunnelSweep.test.mjs:15:import { parsePsOutput, pickStalePids } from "../cli/utils/cloudflared.js";
host/test/tunnelSweep.test.mjs:17:const BIN = "/Users/x/.9remote/bin/cloudflared";
host/test/tunnelSweep.test.mjs:41:  const cmd = "/Users/a b/.9remote/bin/cloudflared tunnel --url http://localhost:2208";
host/test/tunnelSweep.test.mjs:52:test("a cloudflared launched from our managed binary is ours", () => {
host/test/tunnelSweep.test.mjs:57:test("a user's own cloudflared from another path is NOT ours", () => {
host/test/tunnelSweep.test.mjs:61:    { pid: 200, args: "/opt/homebrew/bin/cloudflared tunnel run --token eyJh" },
host/test/tunnelSweep.test.mjs:62:    { pid: 201, args: "/usr/local/bin/cloudflared tunnel --url http://localhost:3000" },
host/test/tunnelSweep.test.mjs:96:    { pid: 89915, args: "/opt/homebrew/bin/cloudflared tunnel run --token eyJh" },
web/shared/i18n/locales/ru.js:187:    headerTitle: "9remote.cc",
web/shared/i18n/locales/fa.js:187:    headerTitle: "9remote.cc",
web/shared/i18n/locales/th.js:187:    headerTitle: "9remote.cc",
web/shared/i18n/locales/ja.js:187:    headerTitle: "9remote.cc",
web/shared/i18n/locales/vi.js:206:    headerTitle: "9remote.cc",
web/shared/i18n/locales/it.js:187:    headerTitle: "9remote.cc",
web/shared/i18n/locales/he.js:187:    headerTitle: "9remote.cc",
web/shared/i18n/locales/id.js:187:    headerTitle: "9remote.cc",
web/shared/i18n/locales/hi.js:187:    headerTitle: "9remote.cc",
web/shared/i18n/locales/pt.js:187:    headerTitle: "9remote.cc",
web/shared/i18n/locales/zh.js:187:    headerTitle: "9remote.cc",
web/shared/i18n/locales/uk.js:187:    headerTitle: "9remote.cc",
web/shared/i18n/locales/nl.js:187:    headerTitle: "9remote.cc",
web/shared/i18n/locales/en.js:298:    headerTitle: "9remote.cc",
web/shared/i18n/locales/es.js:187:    headerTitle: "9remote.cc",
web/shared/i18n/locales/ko.js:187:    headerTitle: "9remote.cc",
web/shared/i18n/locales/ms.js:187:    headerTitle: "9remote.cc",
web/shared/i18n/locales/ar.js:187:    headerTitle: "9remote.cc",
web/shared/i18n/locales/pl.js:187:    headerTitle: "9remote.cc",
web/shared/i18n/locales/tr.js:187:    headerTitle: "9remote.cc",
host/cli/tunnel/manager.js:1:import { spawnQuickTunnel, killCloudflared, hasLiveTunnel } from "../utils/cloudflared.js";
host/cli/tunnel/manager.js:23:// First spawn registers this restart handler in cloudflared.js; subsequent restarts reuse it
host/cli/tunnel/manager.js:30:      // it spawns another cloudflared, whose startup kills the stale pid — which
host/cli/tunnel/manager.js:44:// Never gives up; backoff in minutes to avoid spamming trycloudflare rate limits.
web/shared/i18n/locales/sv.js:187:    headerTitle: "9remote.cc",
web/shared/i18n/locales/de.js:187:    headerTitle: "9remote.cc",
web/shared/i18n/locales/fr.js:187:    headerTitle: "9remote.cc",
host/cli/config.js:4:// target zone stays prod. Override with NREMOTE_WORKER_URL=https://dev.9remote.cc.
host/cli/config.js:8:  || (typeof __DEFAULT_WORKER_URL__ !== "undefined" ? __DEFAULT_WORKER_URL__ : "https://9remote.cc");
host/cli/config.js:45:// Minimum gap between two cloudflared spawns — trycloudflare rate-limits bursts
host/cli/modes/tray.js:10:import { killCloudflared } from "../utils/cloudflared.js";
host/cli/modes/tray.js:58:  try { clearPid("cloudflared"); } catch {}
host/cli/modes/tui.js:9:import { ensureCloudflared, killCloudflared, spawnQuickTunnel } from "../utils/cloudflared.js";
host/cli/modes/tui.js:63:  catch (err) { logger.error(`cloudflared setup failed: ${err?.message || err} — retry from Web UI`); }
host/cli/modes/auto.js:8:import { killCloudflared, spawnQuickTunnel } from "../utils/cloudflared.js";
host/cli/modes/ui.js:11:import { killCloudflared } from "../utils/cloudflared.js";
host/cli/utils/autostart.js:97:// Build PATH env covering system + node bin dir so child spawns (cloudflared, node) work under launchd
web/shared/constants/API.js:2:// Same-origin in the browser (dev.9remote.cc / 9remote.cc follow the deploy).
web/shared/constants/API.js:8:  || (isBrowser ? location.origin : "https://9remote.cc");
web/shared/constants/API.js:9:export const HOMEPAGE_URL = "https://9remote.cc/";
web/shared/constants/API.js:10:export const DOCS_URL = "https://docs.9remote.cc/";
host/cli/utils/pids.js:11: *   - cloudflared  → spawned as a child of agent too, but tracked separately
host/cli/utils/pids.js:18: * those would also terminate unrelated node.exe / cloudflared.exe processes.
host/cli/utils/pids.js:100:export const TRACKED_NAMES = ["cloudflared", "agent"];
host/cli/utils/updateChecker.js:20:// Legacy cloudflared PID path for cleanup during upgrade from older versions
host/cli/utils/updateChecker.js:21:const LEGACY_CLOUDFLARED_PID_FILE = path.join(os.homedir(), ".9remote", "cloudflared.pid");
host/cli/utils/updateChecker.js:211:REM Kill cloudflared first so it stops reconnecting, then kill the agent
host/cli/utils/updateChecker.js:213:REM we never touch unrelated node.exe / cloudflared.exe on this machine.
host/cli/utils/updateChecker.js:215:for %%N in (cloudflared agent) do (
host/cli/utils/updateChecker.js:251:# Kill cloudflared first, then the agent (children die with the agent on
host/cli/utils/updateChecker.js:255:for name in cloudflared agent; do
host/cli/utils/updateChecker.js:436:for %%N in (cloudflared agent) do (
host/cli/utils/updateChecker.js:504:for name in cloudflared agent; do
host/cli/utils/cloudflared.js:29:// cloudflared /ready endpoint reports active edge connection count on ports 20241-20245.
host/cli/utils/cloudflared.js:107:const BINARY_NAME = "cloudflared";
host/cli/utils/cloudflared.js:112:const LEGACY_PID_FILE = path.join(os.homedir(), ".9remote", "cloudflared.pid");
host/cli/utils/cloudflared.js:120:const GITHUB_BASE_URL = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;
host/cli/utils/cloudflared.js:196:    x64: "cloudflared-darwin-amd64.tgz",
host/cli/utils/cloudflared.js:197:    arm64: "cloudflared-darwin-arm64.tgz"
host/cli/utils/cloudflared.js:200:    x64: "cloudflared-windows-amd64.exe"
host/cli/utils/cloudflared.js:203:    x64: "cloudflared-linux-amd64",
host/cli/utils/cloudflared.js:204:    arm64: "cloudflared-linux-arm64"
host/cli/utils/cloudflared.js:298:  const downloadDest = isArchive ? path.join(BIN_DIR, "cloudflared.tgz") : BIN_PATH;
host/cli/utils/cloudflared.js:321:    console.error("Failed to download cloudflared:", error.message);
host/cli/utils/cloudflared.js:342:  // Soft verify: manifest unavailable (cloudflare no longer publishes it) → skip, trust HTTPS
host/cli/utils/cloudflared.js:376:  const regex = /https:\/\/([a-z0-9-]+)\.trycloudflare\.com/gi;
host/cli/utils/cloudflared.js:380:    candidates.push(`https://${match[1]}.trycloudflare.com`);
host/cli/utils/cloudflared.js:388:  // Sweep leftover cloudflared processes from previous runs.
host/cli/utils/cloudflared.js:394:  // Use temp config to avoid conflicting with ~/.cloudflared/config.yml
host/cli/utils/cloudflared.js:412:  writePid("cloudflared", child.pid);
host/cli/utils/cloudflared.js:428:      clearPid("cloudflared");
host/cli/utils/cloudflared.js:483:      logger.info(`cloudflared exited (intentional=${isIntentionalShutdown} superseded=${superseded})`);
host/cli/utils/cloudflared.js:491:        reject(new Error(`cloudflared exited (code=${code}, signal=${signal}) output: ${tail || "(empty)"}`));
host/cli/utils/cloudflared.js:543:    child.on("exit", (code) => { if (!resolved) { resolved = true; clearTimeout(timeout); reject(new Error(`cloudflared exited with code ${code}`)); } });
host/cli/utils/cloudflared.js:547:    console.error("cloudflared error:", error);
host/cli/utils/cloudflared.js:556:  writePid("cloudflared", child.pid);
host/cli/utils/cloudflared.js:580:// Match only cloudflared launched from our binary with 'tunnel' subcommand.
host/cli/utils/cloudflared.js:596:        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'Name=\\'cloudflared.exe\\'' | ForEach-Object { \\"$($_.ProcessId) $($_.CommandLine)\\"" }"`,
host/cli/utils/cloudflared.js:606:// Kill stale cloudflared processes from prior runs to free edge connections.
host/cli/utils/cloudflared.js:611:    logger.info(`killing leftover cloudflared pid=${pid}`);
host/cli/utils/cloudflared.js:617:// Find cloudflared PIDs holding TCP to localhost:port — filtered by image name to avoid false positives
host/cli/utils/cloudflared.js:622:      const ps = `Get-NetTCPConnection -LocalPort ${port} -State Established -ErrorAction SilentlyContinue | Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).Name -eq 'cloudflared' } | Select-Object -ExpandProperty OwningProcess -Unique`;
host/cli/utils/cloudflared.js:652:    const pid = readPid("cloudflared");
host/cli/utils/cloudflared.js:657:      clearPid("cloudflared");
host/cli/utils/cloudflared.js:669:  const pid = readPid("cloudflared");
host/cli/utils/cloudflared.js:746:    const pid = readPid("cloudflared");
host/cli/utils/cloudflared.js:747:    const cloudflaredDead = !pid || !isAlive(pid);
host/cli/utils/cloudflared.js:749:    if (!fingerprintChanged && !cloudflaredDead) {
host/cli/utils/cloudflared.js:759:          // Verify with cloudflared metrics before killing: do not restart if edge connections are still held.
host/cli/utils/cloudflared.js:762:            logger.info(`edge probe failing but cloudflared holds ${conns} connection(s) — not restarting`);
host/cli/utils/cloudflared.js:766:          logger.warn(`tunnel unreachable but cloudflared alive — edge lost after ${edgeFailStreak} probes (ready=${conns ?? "unknown"}), restarting`);
host/cli/utils/cloudflared.js:779:    if (fingerprintChanged && !cloudflaredDead && tunnelReadyAt && Date.now() - tunnelReadyAt < NETWORK_CHANGE_COOLDOWN_MS) {
host/cli/utils/cloudflared.js:784:    if (cloudflaredDead) logger.warn("cloudflared not alive — watchdog");
host/cli/utils/cloudflared.js:793:    if (fingerprintChanged && !cloudflaredDead && activeTunnelUrl) {
host/cli/utils/cloudflared.js:806:    if (fingerprintChanged && !cloudflaredDead) killCloudflared();
host/cli/core/lifecycle.js:10:import { killCloudflared, resetRestartCounter } from "../utils/cloudflared.js";
host/cli/core/lifecycle.js:118:    // Restart ONLY the server child (CLI parent + tunnel + cloudflared untouched).
host/cli/core/lifecycle.js:133:// Restart only the server child (keeps CLI parent + tunnel + cloudflared alive).
host/cli/core/lifecycle.js:150:  try { clearPid("cloudflared"); } catch {}
host/cli/core/lifecycle.js:167:// without this, tray + cloudflared leak and lock dist/ files for next `npm i -g`.
host/cli/core/cmdPoller.js:8:import { ensureCloudflared, spawnQuickTunnel } from "../utils/cloudflared.js";
host/transport/WebRtcProtocol.js:31:  { hostname: "stun.cloudflare.com", port: 3478, type: "Stun" }
host/transport/server.js:694: *  tell them apart: cloudflared runs on this machine, so tunnel traffic lands on
web/shared/utils/tunnelService.js:1:// Named tunnels (t-<shortId>.9remote.cc) are gone — the host runs a quick
web/shared/utils/tunnelService.js:4:const TUNNEL_DOMAIN = "9remote.cc";
web/shared/utils/tunnelService.js:23:    `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?type=CNAME&name=t-${shortId}.${TUNNEL_DOMAIN}`,
web/shared/utils/tunnelService.js:31:      `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${existing.id}`,
web/shared/utils/tunnelService.js:46:    `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}/connections`,
web/shared/utils/tunnelService.js:51:    `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}`,
web/shared/utils/tunnelService.js:70:      `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel?is_deleted=false&status=${status}`,
web/shared/utils/termLog.js:11:// Auto-enable on dev subdomain (dev.9remote.cc) or explicit opt-in. Production
web/shared/utils/termLog.js:12:// (9remote.cc) and host workspace are off by default — zero overhead, no buffer growth.
web/shared/transport/WebRtcProtocol.js:189:      { urls: "stun:stun.cloudflare.com:3478" }
web/shared/transport/ProtocolManager.js:102:    // Re-fetch latest tunnelUrl from Worker in case cloudflared restarted.
web/shared/transport/lib/pmSignaling.js:102:/** The cached tunnelUrl may be stale (cloudflared restarted → new trycloudflare
host/ui/src/components/QRCard.jsx:6:const ENDPOINT = "9remote.cc";
host/ui/src/components/SettingsMenu.jsx:6:const HELP_URL = "https://docs.9remote.cc/";
web/test/hotRoutes.test.mjs:72:const post = (path, body, headers = {}) => new Request(`https://9remote.cc${path}`, {
web/test/hotRoutes.test.mjs:79:  assert.equal(await handleHotRoutes(new Request("https://9remote.cc/api/session/delete", { method: "POST" }), env(fakeDb())), null);
web/test/hotRoutes.test.mjs:83:  assert.equal(await handleHotRoutes(new Request("https://9remote.cc/api/session/heartbeat", { method: "GET" }), env(fakeDb())), null);
web/test/hotRoutes.test.mjs:87:  const res = await handleHotRoutes(new Request("https://9remote.cc/api/session/heartbeat", { method: "OPTIONS" }), env(fakeDb()));
web/test/hotRoutes.test.mjs:194:  const fields = { apiKey: API_KEY, tunnelUrl: "https://x.trycloudflare.com", localIp: "192.168.1.5", ts };
web/test/hotRoutes.test.mjs:198:  assert.equal(row.tunnelUrl, "https://x.trycloudflare.com");
web/test/hotRoutes.test.mjs:205:  db.sessions.set(API_KEY, { apiKey: API_KEY, hostPublicKey: pubRawB64, tunnelUrl: "https://legit.trycloudflare.com" });
web/test/hotRoutes.test.mjs:210:  assert.equal(db.sessions.get(API_KEY).tunnelUrl, "https://legit.trycloudflare.com");
web/test/localAgentOrigin.test.mjs:49:  at("https://dev.9remote.cc/workspace/");
web/test/localAgentOrigin.test.mjs:82:  at("https://app.9remote.cc/workspace");
web/test/localAgentOrigin.test.mjs:89:  at("https://dev.9remote.cc/workspace");
web/test/localAgentOrigin.test.mjs:104:  at("https://dev.9remote.cc/workspace");
host/lib/constants.js:30:// (new trycloudflare subdomains stuck NXDOMAIN until system TTL expires)
host/lib/constants.js:180:  // trycloudflare rate-limits account-less tunnel creation — retrying every few
web/test/signaling-do-e2e.test.mjs:9://   node web/test/signaling-do-e2e.test.mjs wss://dev.9remote.cc/signaling <apiKey>
web/test/signaling-do-e2e.test.mjs:14:const BASE = process.argv[2] || "wss://dev.9remote.cc/signaling";
web/test/rememberedAuth.test.mjs:37:  setAuthData({ apiKey: "HEAD1", tunnelUrl: "https://x.trycloudflare.com", mode: "remote", localIp: "10.0.0.2" });
web/test/rememberedAuth.test.mjs:39:    apiKey: "HEAD1", tunnelUrl: "https://x.trycloudflare.com", mode: "remote", localIp: "10.0.0.2"
web/test/turnKeys.test.mjs:17:  assert.equal(scopeForOrigin("https://dev.9remote.cc"), "dev");
web/test/turnKeys.test.mjs:18:  assert.equal(scopeForOrigin("https://dev.9remote.cc:443"), "dev");
web/test/turnKeys.test.mjs:21:  assert.equal(scopeForOrigin("https://9remote.cc"), "prod");
web/test/turnKeys.test.mjs:22:  assert.equal(scopeForOrigin("https://sites.9remote.cc"), "prod");
host/.env.example:20:# AGENT_CORS_ORIGINS="https://9remote.cc,https://dev.9remote.cc,http://localhost:3000"
host/README.md:25:  [🚀 Quick Start](#-quick-start) • [📱 Platforms](#-supported-platforms) • [✨ 8 Superpowers](#-8-remote-superpowers) • [🛡️ Security](#-zero-trust-security-architecture) • [📊 Comparison](#-how-9remote-compares) • [🌐 Website](https://9remote.cc) • [📖 Docs](https://docs.9remote.cc)
host/README.md:60:| **Web Browser** | — | ✅ | [`https://9remote.cc/login`](https://9remote.cc/login) *(Zero install, any browser)* |
web/test/connect-order.test.mjs:20:globalThis.location = { protocol: "https:", host: "dev.9remote.cc", hostname: "dev.9remote.cc" };
web/test/signalingDoPresence.test.mjs:13:  .replace(/^import \{ DurableObject \} from "cloudflare:workers";$/m, `
web/test/signalingDoPresence.test.mjs:14:class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
web/test/signalingDoPresence.test.mjs:157:// 9. Doc semantics (DurableObjectState::getWebSocketAutoResponseTimestamp):
web/test/signalingDoRelay.test.mjs:11:// The DO imports `cloudflare:workers`, which only exists in the Workers runtime.
web/test/signalingDoRelay.test.mjs:15:  .replace(/^import \{ DurableObject \} from "cloudflare:workers";$/m, `
web/test/signalingDoRelay.test.mjs:16:class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
web/test/signalingDoRelay.test.mjs:22:// Minimal stand-in for DurableObjectState: only the websocket surface the DO uses.
web/package.json:11:    "build:cf": "npm run build && NODE_ENV=production opennextjs-cloudflare build && node scripts/injectSignalingDO.mjs && node scripts/injectHotRoutes.mjs && node scripts/injectScheduled.mjs",
web/package.json:12:    "deploy": "npm run build:cf && opennextjs-cloudflare deploy",
web/package.json:13:    "deploy:dev": "NEXT_PUBLIC_WORKER_URL=https://dev.9remote.cc npm run build:cf && opennextjs-cloudflare deploy --env dev",
web/package.json:14:    "preview": "opennextjs-cloudflare preview",
web/package.json:85:    "@cloudflare/workers-types": "^4.20241218.0",
web/package.json:86:    "@opennextjs/cloudflare": "1.20.1",
web/open-next.config.ts:1:import { defineCloudflareConfig } from "@opennextjs/cloudflare";
web/app/admin/turn/page.js:187:                Scope <span className="font-mono">dev</span> = credentials for pages on dev.9remote.cc only.
desktop/src-tauri/src/lib.rs:119:// Kill host process group so server.cjs + cloudflared children don't leak.
desktop/src-tauri/src/lib.rs:1593:            // exit the shell and leave the host and cloudflared running, with the
web/app/api/admin/turnstile/route.js:1:import { getCloudflareContext } from "@opennextjs/cloudflare";
web/app/api/admin/turnstile/route.js:10:  const { env } = getCloudflareContext();
web/app/api/admin/login/route.js:1:import { getCloudflareContext } from "@opennextjs/cloudflare";
web/app/api/admin/login/route.js:15:    const { env } = getCloudflareContext();
web/app/api/admin/logins/route.js:1:import { getCloudflareContext } from "@opennextjs/cloudflare";
web/app/api/cleanup/route.js:1:import { getCloudflareContext } from "@opennextjs/cloudflare";
web/app/api/cleanup/route.js:9:    const { env } = getCloudflareContext();
web/app/api/session/create/route.js:1:import { getCloudflareContext } from "@opennextjs/cloudflare";
web/app/api/session/create/route.js:12:  const { env } = getCloudflareContext();
web/app/api/session/update/route.js:1:import { getCloudflareContext } from "@opennextjs/cloudflare";
web/app/api/session/update/route.js:12:    const { env } = getCloudflareContext();
web/app/api/session/update/route.js:34:    // cloudflared restarts hand out a new trycloudflare URL — a stale cached one
web/app/api/session/heartbeat/route.js:1:import { getCloudflareContext } from "@opennextjs/cloudflare";
web/app/api/session/heartbeat/route.js:15:    const { env } = getCloudflareContext();
web/app/api/session/delete/route.js:1:import { getCloudflareContext } from "@opennextjs/cloudflare";
web/app/api/session/delete/route.js:11:    const { env } = getCloudflareContext();
web/app/api/webrtc/turn-credentials/route.js:1:import { getCloudflareContext } from "@opennextjs/cloudflare";
web/app/api/webrtc/turn-credentials/route.js:12:    const { env } = getCloudflareContext();
web/app/api/version/route.js:1:import { getCloudflareContext } from "@opennextjs/cloudflare";
web/app/api/version/route.js:9:    const { env } = getCloudflareContext();
web/app/api/iap/verify/route.js:1:import { getCloudflareContext } from "@opennextjs/cloudflare";
web/app/api/iap/verify/route.js:12:    const { env } = getCloudflareContext();
web/app/api/iap/entitlement/route.js:1:import { getCloudflareContext } from "@opennextjs/cloudflare";
web/app/api/iap/entitlement/route.js:9:    const { env } = getCloudflareContext();
web/app/api/iap/account/route.js:1:import { getCloudflareContext } from "@opennextjs/cloudflare";
web/app/api/iap/account/route.js:9:    const { env } = getCloudflareContext();
web/app/api/iap/account/route.js:30:    const { env } = getCloudflareContext();
web/app/api/temp-key/verify/route.js:1:import { getCloudflareContext } from "@opennextjs/cloudflare";
web/app/api/temp-key/verify/route.js:18:    const { env } = getCloudflareContext();
web/app/api/temp-key/create/route.js:1:import { getCloudflareContext } from "@opennextjs/cloudflare";
web/app/api/temp-key/create/route.js:37:    const { env } = getCloudflareContext();
web/app/api/temp-key/remove/route.js:1:import { getCloudflareContext } from "@opennextjs/cloudflare";
web/app/api/temp-key/remove/route.js:10:    const { env } = getCloudflareContext();
web/app/api/connect/route.js:1:import { getCloudflareContext } from "@opennextjs/cloudflare";
web/app/api/connect/route.js:38:    const { env } = getCloudflareContext();
web/app/api/ota/publish/route.js:1:import { getCloudflareContext } from "@opennextjs/cloudflare";
web/app/api/ota/publish/route.js:11:    const { env } = getCloudflareContext();
web/app/api/ota/manifest/route.js:1:import { getCloudflareContext } from "@opennextjs/cloudflare";
web/app/api/ota/manifest/route.js:7:  const { env } = getCloudflareContext();
web/app/api/host-status/route.js:1:import { getCloudflareContext } from "@opennextjs/cloudflare";
web/app/api/host-status/route.js:17:    const { env } = getCloudflareContext();
web/app/layout.js:57:// Redirect Expo WebView from dev.9remote.cc to production 9remote.cc
web/app/layout.js:58:const expoRedirectScript = `(function(){try{if(location.hostname==="dev.9remote.cc"&&(window.ReactNativeWebView||/9Remote-Mobile/i.test(navigator.userAgent))){location.replace("https://9remote.cc"+location.pathname+location.search+location.hash);}}catch(e){}})();`;
web/next.config.mjs:5:import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
web/next.config.mjs:20:  // standalone builds (used by opennextjs-cloudflare) to resolve hoisted deps
web/next.config.mjs:23:  // .next/standalone/web/* → .next/standalone/* for opennextjs-cloudflare.
web/next.config.mjs:41:    "*.trycloudflare.com",
web/next.config.mjs:47:    NEXT_PUBLIC_WORKER_URL: process.env.NEXT_PUBLIC_WORKER_URL || "https://9remote.cc",
web/next.config.mjs:104:      // fresh *.trycloudflare.com host on every restart — but the shapes are:
web/next.config.mjs:110:        "https://*.trycloudflare.com wss://*.trycloudflare.com",
web/next.config.mjs:111:        "https://*.9remote.cc wss://*.9remote.cc",
web/next.config.mjs:124:      "frame-src 'self' blob: https://*.9remote.cc http://sites.localhost:2200",
desktop/chromeShell/config.json:4:  "url": "https://dev.9remote.cc",
web/migrations/003_add_shortId.sql:1:-- Add shortId column for tunnel subdomain (_t-{shortId}.9remote.cc)
web/durable-objects/SignalingDO.js:1:import { DurableObject } from "cloudflare:workers";
web/durable-objects/SignalingDO.js:134:export class SignalingDO extends DurableObject {
web/hotRoutes.js:139:// ── routes (verbatim bodies; getCloudflareContext → env param) ────────────
scripts/buildPkg.js:58:    "__DEFAULT_WORKER_URL__": JSON.stringify("https://9remote.cc"),
scripts/buildPkg.js:70:    external: ["node-pty", "sharp", "cloudflared", "@hurdlegroup/robotjs", "node-datachannel", "node-screenshots", "koffi", "systray", "fsevents", "@julusian/jpeg-turbo"],

```