# Cloud / Worker

Cloudflare Worker: API gateway + D1 + cron. Cấp tunnel, TURN credentials, temp-key.

## Endpoints

| Method | Path | Auth | Body/Query | Response |
|---|---|---|---|---|
| POST | `/api/tunnel/create` | apiKey | `{apiKey}` | `{tunnelId, token, hostname}` |
| DELETE | `/api/tunnel/delete` | apiKey | `{apiKey}` | `{success}` |
| GET | `/api/webrtc/turn-credentials` | `X-API-Key` | — | `{iceServers}` (TTL 24h) |
| POST | `/api/temp-key/create` | apiKey | `{apiKey, expiryMinutes?=30}` | `{tempKey, expiresAt, expiryMinutes}` |
| GET | `/api/temp-key/verify?k=XXX` | — | — | `{apiKey, tempKey}` (410 expired) |
| DELETE | `/api/temp-key/remove` | — | `{tempKey}` | `{success, removed}` |
| POST | `/api/connect` | — | `{token \| apiKey, tempKey?}` | `{tunnelUrl, apiKey, tempKey, localIp}` |
| GET | `/api/cleanup` | `Bearer ${CLOUDFLARE_API_KEY}` | — | `{sessions, tempKeys, tunnels}` |
| GET | `/api/version` | — | — | `{version, buildTime, minAppVersion, forceUpdate}` |

Plus admin: login, sessions CRUD, modes CRUD, stats.

## D1 schema

```sql
sessions(apiKey, machineId, tunnelId, tunnelUrl, shortId, publicIp, localIp, expiresAt, lastAccessAt)
temp_keys(temp_key, api_key, expires_at, created_at)
modes(id PK, name, permissions JSON, createdAt)            -- defaults: superAdmin, viewer
admins(id PK, username UNIQUE, passwordHash, modeId FK, createdAt, lastLoginAt)  -- default: anhvh/admin_default
```

Migrations: 001 add tunnelId · 002 expiry 4h→7d + lastAccessAt · 003 add shortId · 004 add publicIp+localIp · 005 admin tables.

## Tunnel lifecycle

```
createTunnel(apiKey):
  shortId = derive(apiKey)
  name = "9remote-{shortId}"
  hostname = "t-{shortId}.9remote.cc"

  1. getTunnelByName → reuse | POST /accounts/{acct}/cfd_tunnel {name, config_src:"cloudflare"}
  2. GET /accounts/{acct}/cfd_tunnel/{id}/token
  3. upsertDnsRecord (zone 34ed092484851b44d0ede479b0288738):
       PATCH | POST {type:"CNAME", name:"t-{shortId}", content:"{tunnelId}.cfargotunnel.com", proxied:true}
  4. PUT /cfd_tunnel/{id}/configurations
       ingress:[{hostname, service:"http://localhost:2208"},{service:"http_status:404"}]
  5. INSERT/UPDATE sessions

deleteTunnel: deleteDnsRecord → DELETE /connections → DELETE tunnel
Headers: X-Auth-Email, X-Auth-Key
```

## TURN flow

```
GET /api/webrtc/turn-credentials  X-API-Key
  → verifyApiKeyCrc(apiKey)  // 401 if fail
  → POST https://rtc.live.cloudflare.com/v1/turn/keys/{TURN_KEY_ID}/credentials/generate-ice-servers
        Bearer ${TURN_KEY_SECRET}  body:{ttl:86400}
  → return {iceServers}
```

Client cache 24h, refresh 1h trước expiry (`turnRefreshInterval`).

## Temp-key flow

```
POST /api/temp-key/create {apiKey, expiryMinutes:30}
  → DELETE existing for apiKey
  → 6-char [A-Z2-9 trừ I,O,1,0], retry 10x nếu collision
  → INSERT temp_keys
  → {tempKey, expiresAt}

GET /api/temp-key/verify?k=XXX
  → upper case
  → expired → DELETE row + 410
  → {apiKey, tempKey}        // KHÔNG delete (không one-time enforce)

POST /api/connect {tempKey:"ABC123"}
  → length<=10 && /^[A-Z0-9]+$/i → lookup temp_keys
  → trả tunnelUrl + apiKey thật
```

## Cron

```
crons = ["0 * * * *"]   # hourly

/api/cleanup:
  DELETE FROM sessions WHERE expiresAt < datetime('now')
  DELETE FROM temp_keys WHERE expires_at < <now-ms>
  cleanupDeadTunnels:
    list status=down|inactive|degraded
    filter name LIKE "9remote-%"
    if last closed_at|created_at > 1h → deleteTunnel
```

## Worker config

```toml
# wrangler.toml
name = "9remote-worker"
main = ".open-next/worker.js"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]
routes = [{ pattern = "9remote.cc/*", zone_name = "9remote.cc" }]

[vars]
CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_EMAIL, CLOUDFLARE_API_KEY
TURN_KEY_ID, TURN_KEY_SECRET
BUILD_VERSION, BUILD_TIME

[[d1_databases]]
binding = "DB"
database_name = "9remote"
database_id = "df1dac06-213c-444d-8751-b7918e044356"

[triggers] crons = ["0 * * * *"]
[assets] directory = ".open-next/assets"
```

Không có KV.

## Files

```
web/app/api/
  tunnel/{create,delete}/route.js
  webrtc/turn-credentials/route.js
  temp-key/{create,verify,remove}/route.js
  connect/route.js
  cleanup/route.js
  version/route.js
  session/, login/, mode/, stats/  (admin)

web/migrations/        001-005 SQL
web/wrangler.toml      worker config
web/shared/utils/tunnelService.js   client fetch helpers
```

## Mở rộng

- **Endpoint mới**: tạo `web/app/api/<name>/route.js`, export `GET/POST/DELETE`.
- **Schema thay đổi**: thêm migration `00X_*.sql` + `wrangler d1 migrations apply 9remote`.
- **Var/Secret mới**: `wrangler.toml [vars]` (public) hoặc `wrangler secret put` (secret).
- **Cron khác**: thêm `crons` array + route handler.
