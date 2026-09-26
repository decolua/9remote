# 🛡️ 9Remote Security Audit & Engineering Handoff

**Date**: 2026-09-25  
**Project**: 9Remote (`agent/`, `web/`, `desktop/`, `expo/`)  
**Scope**: Full Security Architecture Review, Vulnerability Assessment, and Remediation Roadmap.

---

## 1. Executive Summary

9remote là giải pháp remote terminal + remote desktop + file explorer gồm 2 runtime chính:
- **`agent/`**: Node.js CLI daemon chạy trên máy chủ (host), cung cấp PTY terminals, WebRTC screen streaming, file explorer, local HTTP proxy và AI session runtime.
- **`web/`**: Next.js App Router chạy trên Cloudflare Workers (OpenNext) kết nối cơ sở dữ liệu Cloudflare D1 và Durable Objects (signaling relay).

Codebase đã trải qua một đợt nâng cấp bảo mật lớn so với đợt audit cũ (tháng 05/2026):
- ✅ **Đã hoàn thiện**: Chuyển đổi API key sang v2 (`sk-{machineId8}-{rand8}-{rand8}` với HEAD dùng định tuyến và TAIL làm private device secret).
- ✅ **Đã hoàn thiện**: Bỏ các chuỗi secret fallback hardcoded (`ADMIN_JWT_SECRET`, `TOKEN_SECRET`).
- ✅ **Đã hoàn thiện**: Đặt `chmod 0600` cho `pty-daemon.sock` và dùng `writeJsonAtomic` với quyền `0600` cho `keys.json`.
- ✅ **Đã hoàn thiện**: Chuyển các lệnh `git` trong `GitHandler.js` sang dùng mảng đối số với `spawn`/`spawnSync` thay vì nội suy chuỗi shell.
- ✅ **Đã hoàn thiện**: Thêm Ed25519 host key signing để bảo vệ `/api/session/update` và `/api/session/delete`.

Tuy nhiên, **vẫn còn tồn tại các lỗ hổng nghiêm trọng (Critical/High)** liên quan đến lộ lọt secret trong lịch sử Git, SSRF bypass qua proxy API, endpoint unauthenticated, cấu hình mạng LAN và xung đột môi trường D1 database.

---

## 2. Bảng tổng hợp lỗ hổng an ninh (Vulnerability Matrix)

| Cấp độ | Mã | Phân loại | File / Vị trí | Tóm tắt lỗ hổng |
| :--- | :--- | :--- | :--- | :--- |
| 🔴 **CRITICAL** | **C1** | Info Disclosure / Credential Leak | Git History (`2b3a0038`, `df073217`, `4955abf0`) | Cloudflare API Key, TURN Secret, Admin Secrets vẫn nằm trong git history |
| 🔴 **CRITICAL** | **C2** | SSRF / Device Gate Bypass | `agent/index.js:245-266`<br>`agent/proxy/index.js:12-38` | `/api/proxy/start` chỉ check `headOf(key)`, bypass hoàn toàn Device Approval Gate |
| 🔴 **CRITICAL** | **C3** | Unauthenticated Public API | `agent/index.js:299-300`<br>`agent/api/notify.js:45-91` | `/api/notify` mở public không auth, cho phép spam push, giả mạo trạng thái |
| 🔴 **CRITICAL** | **C4** | Account / Host Hijack | `web/app/api/session/create/route.js:22-62`<br>`web/shared/utils/sessionMutationAuth.js:79-83` | Cho phép đăng ký đè `hostPublicKey` trên session chưa có key, khóa vĩnh viễn agent thật |
| 🔴 **CRITICAL** | **C5** | Environment Collision | `web/wrangler.toml:52, 116` | Dev và Production dùng chung D1 database UUID (`1ed9a290-...`) |
| 🟠 **HIGH** | **H1** | LAN Exposure | `agent/index.js:371, 537` | `server.listen(port)` không truyền hostname, tự động bind vào `0.0.0.0` |
| 🟠 **HIGH** | **H2** | DoS / CSWSH Risk | `agent/transport/server.js:760-776` | Socket.IO `origin: "*"`, `credentials: true`, `maxHttpBufferSize: 1e8` (100MB) |
| 🟠 **HIGH** | **H3** | Client Credential Storage | `web/shared/hooks/useSessionStorage.js:45, 82` | Cookie thiếu `Secure`/`HttpOnly`, raw API key lưu vĩnh viễn trong `localStorage` |
| 🟠 **HIGH** | **H4** | Insecure Temp File / Symlink | `agent/cli/utils/updateChecker.js:446, 499-501` | Script update ghi vào `/tmp/9remote-update.sh` cố định, nguy cơ symlink overwrite |
| 🟠 **HIGH** | **H5** | Integrity Bypass (Fail-Open) | `agent/cli/utils/cloudflared.js:342-353` | Bỏ qua kiểm tra SHA256 checksum khi tải cloudflared nếu manifest lỗi |
| 🟠 **HIGH** | **H6** | CORS Wildcard on Worker API | `web/shared/utils/apiResponse.js:1-5` | Trả về `Access-Control-Allow-Origin: *` trên toàn bộ Worker API endpoints |
| 🟡 **MEDIUM** | **M1** | Non-enforcing CSP & Invalid IPs | `web/next.config.mjs:85-89, 110` | CSP đặt chế độ `Report-Only`; cú pháp `http://192.168.*` không hợp chuẩn W3C |
| 🟡 **MEDIUM** | **M2** | Memory DoS on Upload | `agent/features/terminal/handlers/InputHandler.js:140` | `Buffer.from(content, "base64")` không kiểm tra giới hạn size trước khi allocate |
| 🟡 **MEDIUM** | **M3** | Non-Constant-Time Compare | `agent/lib/localToken.js:24`<br>`web/app/api/ota/publish/route.js:14` | So sánh token bằng `===` và `!==` thay vì timing-safe compare |
| 🟢 **LOW** | **L1** | Blacklist-based Path Jail | `agent/features/fileExplorer/pathGuard.js:63-73` | Chỉ chặn các thư mục nhạy cảm được liệt kê, không jail theo allowlist workspace |

---

## 3. Chi tiết phân tích kỹ thuật các lỗ hổng chính

### 3.1. [C1] Lộ lọt Secret trong lịch sử Git
- **Chi tiết**: Commit `36fef0a2` (`chore: scrub secrets...`) chỉ xóa các giá trị plaintext ở commit đó và gỡ `wrangler.toml` khỏi tracking. Khi kiểm tra git log:
  ```bash
  git log -S "TURN_KEY_SECRET" --oneline
  # f79215d5, 9fc6763d, 36fef0a2, 4955abf0, 2b3a0038, df073217
  ```
  Các commit cũ vẫn lưu trữ đầy đủ `CLOUDFLARE_API_KEY`, `TURN_KEY_SECRET`, email và hash password.
- **Rủi ro**: Lộ tài khoản Cloudflare, bị lạm dụng Cloudflare Worker/KV/D1 và TURN server trả phí.

### 3.2. [C2] SSRF & Bypass Device Gate qua `/api/proxy/start`
- **Chi tiết**:
  ```javascript
  // agent/index.js
  async function handleProxyStartEnd(req, res, { pathname }) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ") || !matchesLocalKey(authHeader.slice(7), loadKey()?.key)) {
      jsonErr(res, 401, "Unauthorized");
      return;
    }
    // ...
    const sessionId = startProxySession(data.port);
    jsonOk(res, { success: true, sessionId });
  }
  ```
  Hàm `matchesLocalKey` (`agent/cli/utils/apiKey.js:40-43`) chỉ so sánh `headOf(presented)` với `headOf(storedKey)`.
  Phần HEAD (`sk-{machineId8}-{rand8}`) là thông tin định tuyến công khai được endpoint `/api/connect` trả về cho bất kỳ client nào xác thực qua mã tạm.
  Kẻ tấn công có được HEAD có thể gọi `/api/proxy/start` với bất kỳ port nào (`127.0.0.1:port`) mà **không cần host phê duyệt thiết bị** (`deviceApproval`), sau đó truy cập tài nguyên nội bộ qua `/proxy/<sessionId>/*`.

### 3.3. [C3] Endpoint công khai `/api/notify` không xác thực
- **Chi tiết**: Tại `agent/index.js`:
  ```javascript
  { path: "/api/notify", method: "POST", public: true, handler: handleNotifyPost },
  { path: "/api/notify", method: "GET",  public: true, handler: handleNotifyGet },
  ```
  `handleNotifyPost` và `handleNotifyGet` trong `agent/api/notify.js` đọc body/query rồi trực tiếp gọi `commitNotify` mà không xác thực:
  - Broadcast `statusChange` và `chatNotification` tới mọi client đang kết nối.
  - Gửi Push Notification qua `sendPushNotification`.
  - Kích hoạt logic Jarvis AI: `onWorkerDone(sessionId)` và `requestAutoName(sessionId)`.

### 3.4. [C4] Chiếm quyền Host Key trên Session chưa đăng ký
- **Chi tiết**: Tại `web/shared/utils/sessionMutationAuth.js`:
  ```javascript
  export function canReplaceHostKey({ stored, presented, pairedNow }) {
    if (!stored) return true; // Lỗ hổng: session chưa có key -> chấp nhận bất kỳ key nào
    if (stored === presented) return true;
    return pairedNow === true;
  }
  ```
  Nếu một session được tạo lần đầu bởi attacker biết API key HEAD (hoặc session cũ từ bản v1 chưa có `hostPublicKey`), attacker có thể gọi `POST /api/session/create` với public key của attacker. Khi agent thật khởi động, agent không gửi `tempKey` trong payload boot nên `canReplaceHostKey` trả về `false`. Kể từ đó, agent thật không bao giờ update được `tunnelUrl` (bị 403 do sai signature).

### 3.5. [C5] D1 Database bị dùng chung giữa Dev và Production
- **Chi tiết**: `web/wrangler.toml` định nghĩa:
  - Production `[[d1_databases]]`: `id = "1ed9a290-81e1-4e0c-b662-753b9ec99c2e"`
  - Dev `[[env.dev.d1_databases]]`: `id = "1ed9a290-81e1-4e0c-b662-753b9ec99c2e"`
  Bất kỳ lệnh test dev hoặc deploy thử nghiệm nào cũng can thiệp trực tiếp vào database production.

### 3.6. [H1] Agent HTTP Server bind `0.0.0.0`
- **Chi tiết**: Tại `agent/index.js`:
  ```javascript
  const hostname = "localhost"; // dòng 371
  const port = parseInt(process.env.PORT || "2208", 10);
  // ...
  server.listen(port, (err) => { ... }); // dòng 537 - thiếu tham số hostname!
  ```
  Trong Node.js, `server.listen(port)` mặc định bind vào `INADDR_ANY` (`0.0.0.0`), mở port 2208 ra toàn bộ mạng LAN/Wi-Fi công cộng.

---

## 4. Hướng dẫn khắc phục chi tiết (Remediation Plan)

### P0.1. Xóa sạch Secret khỏi Git History & Rotate Credentials
1. **Rotate trên Cloudflare Dashboard**:
   - Thu hồi và tạo mới `CLOUDFLARE_API_KEY`.
   - Tạo mới `TURN_KEY_SECRET`.
   - Đổi `ADMIN_JWT_SECRET` và password admin.
2. **Scrub Git History** bằng `git-filter-repo`:
   ```bash
   # Cài đặt git-filter-repo (ví dụ: pip install git-filter-repo hoặc brew install git-filter-repo)
   git filter-repo --replace-text <(cat << 'EOF'
   <CLOUDFLARE_API_KEY_CU>==>REDACTED_CF_KEY
   <TURN_KEY_SECRET_CU>==>REDACTED_TURN_SECRET
   EOF
   ) --force
   ```

### P0.2. Tách D1 Database Dev & Prod trong `web/wrangler.toml`
Tạo database dev riêng trên Cloudflare:
```bash
npx wrangler d1 create 9remote-dev
```
Cập nhật `web/wrangler.toml`:
```toml
[env.dev.d1_databases]
binding = "DB"
database_name = "9remote-dev"
database_id = "<UUID_MỚI_CỦA_DEV>"
```

### P0.3. Vá lỗ hổng SSRF tại `/api/proxy/start`
Yêu cầu kiểm tra TAIL đầy đủ và kiểm tra quyền thiết bị đã được host duyệt:
```javascript
// agent/index.js
import { isTailProofEnabled, verifyKeyTail } from "./lib/deviceAuth.js";
import { isDeviceApproved } from "./lib/deviceApproval.js";

async function handleProxyStartEnd(req, res, { pathname }) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  // Bắt buộc xác thực bằng key TAIL (private secret) hoặc localToken
  const isLocalUi = token && token === getLocalToken();
  const isTailValid = token && isTailProofEnabled() && verifyKeyTail(tailOf(token));
  if (!isLocalUi && !isTailValid) {
    jsonErr(res, 401, "Unauthorized");
    return;
  }
  // Chặn các cổng nhạy cảm
  const FORBIDDEN_PORTS = new Set([22, 23, 25, 53, 137, 139, 445, 2375, 3306, 5432, 6379, 27017]);
  if (FORBIDDEN_PORTS.has(data.port)) {
    jsonErr(res, 403, "Port forbidden");
    return;
  }
  // ...
}
```

### P0.4. Bảo vệ `/api/notify`
Yêu cầu header Authorization với `localToken` hoặc API key hợp lệ:
```javascript
// agent/api/notify.js
import { matchesLocalKey } from "../cli/utils/apiKey.js";
import { loadKey } from "../cli/utils/state.js";
import { getLocalToken } from "../lib/localToken.js";

function isNotifyAuthorized(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return false;
  return token === getLocalToken() || matchesLocalKey(token, loadKey()?.key);
}
```

### P1.1. Bind Agent HTTP Server vào `127.0.0.1`
```javascript
// agent/index.js:537
server.listen(port, hostname, (err) => {
  if (err) throw err;
  // ...
});
```

### P1.2. Thắt chặt CORS & DoS Buffer trong Socket.IO Server
```javascript
// agent/transport/server.js:759
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      // Cho phép null (non-browser/mobile) hoặc các domain chính thức
      if (!origin || LOCAL_UI_ORIGINS.includes(origin) || origin.endsWith(".9remote.cc")) {
        return callback(null, true);
      }
      return callback(new Error("CORS rejected"), false);
    },
    methods: ["GET", "POST"],
    credentials: true
  },
  maxHttpBufferSize: 5 * 1024 * 1024, // Giảm từ 100MB xuống 5MB
  // ...
});
```

### P1.3. An toàn hóa thư mục tạm trong Auto-Update
```javascript
// agent/cli/utils/updateChecker.js
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9remote-upd-"));
const scriptPath = path.join(tempDir, `${PACKAGE_NAME}-update.sh`);
fs.writeFileSync(scriptPath, script, { mode: 0o700 });
```

### P2.1. Chuẩn hóa CORS & Security Headers cho Web API
Trong `web/shared/utils/apiResponse.js`, thay vì trả về `Access-Control-Allow-Origin: *`, kiểm tra `Origin` request dựa trên `ALLOWED_ORIGINS` (từ Cloudflare env vars).

---

## 5. Trạng thái mã nguồn hiện tại (Current Worktree Status)

Khi kiểm tra `git status`, repository đang có 2 file bị sửa đổi cục bộ (chưa commit):
- `agent/features/ai/aiSession.js`
- `agent/features/ai/aiSocket.js`

**Mục đích thay đổi**: Thêm cơ chế `ensureProcAlive()` giúp tự động hồi phục các session AI daemon bị "zombie" sau khi agent update hoặc CLI crash mà không làm mất turn chat của người dùng. Code logic sạch và an toàn, không xung đột với các sửa đổi bảo mật nêu trên.

---

## 6. Checklist bàn giao vận hành (Operational Checklist)

- [ ] Thực hiện rotate secret Cloudflare & TURN trên production.
- [ ] Chạy `git-filter-repo` để làm sạch commit history repo.
- [ ] Cập nhật `database_id` riêng cho `[env.dev.d1_databases]` trong `web/wrangler.toml`.
- [ ] Áp dụng patch cho `agent/index.js` (bind `127.0.0.1`, auth `/api/notify`, fix `/api/proxy/start`).
- [ ] Cập nhật CORS allowlist cho Web API & Socket.IO server.
- [ ] Kiểm tra liveness và WebRTC streaming trên thiết bị iOS / Android sau khi siết CORS.
