# ARemote Phase 1 独立验收报告

- 日期：2026-10-26
- 审查方式：Claude Code 前台会话，模型 GLM-5.3（1M 上下文），未使用子代理
- 审查对象：`phase1/self-hosted-relay` 分支 HEAD `968cd51d` + 当前工作树（含未提交改动）
- 环境：Linux 6.12.94-deb13-cloud-amd64，Node v24.21.0，Git/gh/Docker CLI 26.1.5
- 约束遵守：只读审查 + 本地测试；未修改源码、未提交/推送、未部署外网、未读取或输出真实凭证（测试中的口令均为测试字面量；冒烟测试使用临时口令与临时目录，进程与目录已清理）。唯一写入为本报告。

---

## 一、既有证据的独立复验结果

| 证据项 | 复验方式 | 结果 |
| --- | --- | --- |
| `npm run server:test` 六项通过 | 本机重跑 | ✅ 6/6 通过（1.7s） |
| `node --test host/aremote/test/integration.test.js` 通过 | 本机重跑 + 逐行阅读断言 | ✅ 1/1 通过（19.2s）。断言真实覆盖：真实 bash PTY（`printf 'AREMOTE_%s' 'PTY_OK'` 标记回读）、文件写/读往返、`/etc/shadow` 读取拒绝、Server 关闭重启后 Host 自动重连且**原 PTY 会话恢复输出**（`RESTART_OK`）、host 日志无 signaling/cloudflared 输出。客户端还故意伪造 `deviceId: "spoofed-client-id"`，证明 Host 侧以中继身份为准、不信任客户端自报身份 |
| `npm run client:build` 成功 | 本机重跑 | ✅ 静态导出完成，`web/out` 生成（20 个路由全部 Static/SSG） |
| 浏览器验证（`/tmp/aremote-browser-validation.mjs` + `.log`） | 审阅脚本与日志，并对每个外部请求/404 独立溯源到产物与源码行号 | ✅ 配对注册/ACL 授权/relay 会话成立（`RELAY_SESSIONS 1`，无 JS 错误）。脚本质量良好：对非 Server origin 的请求强制 abort 并记录，避免了"漏抓外部请求"。注意：浏览器会话只进入 workspace（"No terminals here"），**终端 I/O 未在浏览器中实际操作**，该路径由集成测试以 socket.io-client 覆盖 |
| Docker 构建失败 | 审阅 `/tmp/aremote-docker-build.log`，未重复完整构建 | ✅ 失败确认：`[web 11/11] RUN node scripts/buildWebStatic.mjs` → `/bin/sh: 1: git: not found`（exit 127）。详见问题 #1 |
| CI run 40175042670（968cd51）三 job 成功、含真实 APK/EXE | `gh run view` + 本地 `artifacts/` 校验 | ✅ server/android/windows 三 job 成功；本地产物 `ARemote_0.1.0_x64-setup.exe`（1,947,870 B，SHA256 `19acc63c565dd1240206b8e70a6e2c50b2926a651784cda672caf6c4912026f0`）、`app-debug.apk`（9,076 B，SHA256 `029fddc6077c7a79a5f2ddbc648831cce4291dc1fc6e281d0fcdf376be53e6dc`）。**未做真机安装验收**（按要求不执行） |

补充独立冒烟测试（本机临时起 `server/index.js`，`WEB_DIR=web/out`）：`/health` `/admin` `/login` `/fonts/material-symbols.css` `/manifest.json` 均 200；`/admin` 返回 **ARemote 自有管理页**（优先于静态导出的上游 /admin）；路径穿越（含编码形式）均 404；`/api/ui/events` 404（与浏览器验证一致）。

---

## 二、专项核查结论

### 2.1 静态导出是否被误判为 Host 环境 —— 是，已定位根因

- 根因：`web/shared/utils/localOrigin.js:29`，`isHostEnvironment()` 把 `NEXT_PUBLIC_STATIC_EXPORT === "1"` 视为 Host 环境。该变量由 `scripts/buildWebStatic.mjs:63`（`STATIC_EXPORT=1`）在**同一份**静态导出中固化——而这份导出同时被 Host 本地 UI 和 ARemote Server（`WEB_DIR`）两处提供服务。
- 触发链：远程 Client 从 Server 打开 `/workspace` → `web/app/workspace/layout.js:1260` 无条件挂载 `PendingDeviceApprovalModal` → 其 `useEffect`（`PendingDeviceApprovalModal.js:31,43`）打开 `EventSource("/api/ui/events")`（404 后浏览器自动重试）并以 3 秒间隔轮询 `/api/device/pending`（404）。`AgentDashboardView.js:630-704`（pair 视图）拉取 `/api/ui/state`、`/api/connections`、`/api/device/approved|rejected|auto-approve`、`/api/remote/enabled`、`/api/version`，全部 404。设置面板日志（`logStore.js:53`）同样命中 `/api/ui/events`。
- 实际功能影响：**无崩溃、无数据泄露**（验证日志 `ERRORS []`，404 返回 JSON）；但存在持续性后台 404 请求（SSE 重连 + 3s 轮询）、主机面板显示错误的"不可达"状态，并把永远无法工作的主机管理 UI（设备批准/配对仪表盘）呈现给中继客户端——ARemote 模式下设备批准在 Server 侧完成，这些组件本不该挂载。定性：中等严重性的正确性/体验缺陷，非安全问题。

### 2.2 外部请求溯源（区分"字符串出现"与"运行时依赖"）

| 请求 | 运行时证据 | 源头 | 结论 |
| --- | --- | --- | --- |
| `fonts.googleapis.com/css2` ×2 | 浏览器日志 EXTERNAL | `web/app/globals.css:1-2` 的 `@import`（构建产物 `web/out/_next/static/css/7a2c6748e13fd3ae.css` 中保留）；HEAD 版 `web/app/layout.js:79` 另有 `<link>`（工作树已改本地 `/fonts/material-symbols.css`，本地路径在日志 REQUESTS 中确认命中） | **真实运行时依赖**。图标有本地兜底，Inter 断网回退系统字体；隐私上每次加载向 Google 泄露客户端 IP |
| `api.github.com/repos/decolua/9remote` | 浏览器日志 EXTERNAL | `web/shared/constants/github.js:3-7` + `web/shared/hooks/useGithubStars.js:29`，挂在**工作区常驻组件** `TerminalHeader.js:145`、`SlideMenu.js:29` | **真实运行时依赖**，且指向上游仓库而非 fork |
| `https://9remote.cc` | 无自动请求（产物 `chunks/8126-*.js` 中为 `HOMEPAGE_URL/DOCS_URL` 链接常量） | 静态文案/链接 | 仅用户点击时跳转，非运行时依赖；品牌残留 |
| GA / googletagmanager | 产物中无 `gtag/googletagmanager` 命中；工作树 `layout.js` 已删 `<GoogleAnalytics>`，`.env.production` 已清空 ID | — | ✅ 工作树已移除（但 HEAD 未提交，见 #2） |
| Turnstile（challenges.cloudflare.com） | 仅存在于上游 `/admin/login` 静态页 chunk | 死页面 | 非激活路径；建议排除这些路由 |

### 2.3 Host 出站纯净性（反向中继）

- `host/index.js:479-481`：`AREMOTE_SERVER_URL` 存在时本地服务仅绑定 `127.0.0.1` 并**跳过 `checkForUpdate`**（不再访问 npm registry/GitHub）。
- 集成测试断言 host 输出无 `global signaling client started` / `trycloudflare.com`；`pmConfig.js:12` 在 AREMOTE 下强制 `["ws"]`（RTC/DO 信令禁用，符合 Phase 1 设计）。
- 中继只连固定 loopback Socket.IO 端点（`connector.js:38`），无任意目标连接 → 无 SSRF 面。

---

## 三、安全属性逐项核对（源码级）

| 属性 | 结论 | 依据 |
| --- | --- | --- |
| 身份隔离（角色不可互换） | ✅ | 注册角色白名单（`server/app.js:103`）；`/api/hosts`、`/api/tickets` 要求 client 角色（:127,:131），`/relay/host` 要求 host 角色（`server/relay.js:34`）；Host/Client token 互用均 401（测试覆盖） |
| 凭证存储 | ✅ | 仅存 SHA-256（`server/store.js:28-31`）；管理 API 任何响应不含 token/tokenHash（测试断言）；host 端 `device.json` 0600 原子写（`host/aremote/index.js:12-15`） |
| ACL 默认拒绝 + 授权 | ✅ | `/api/tickets` 检查 grants（`app.js:132`）；ticket 30s 一次性、upgrade 时二次校验 ACL（`relay.js:41-43`）；配对码 10 分钟、事务内一次性消费防并发重放（`app.js:107-117`） |
| 撤销/轮换即时生效 | ✅ | `dropDevice`/`revokeGrant` 关闭连接、会话、未用 ticket（`relay.js:17-26`）；rotate 后旧 token 401（测试覆盖）。遗留小缺陷见 #8（关闭码复用 4003） |
| 会话路由防注入 | ✅ | sessionId 由服务端 `randomUUID` 生成；Host 侧帧路由校验 `s.host !== ws`（`relay.js:63-71`）；host 本地以不可猜 identity token 映射（`relayIdentity.js`，仅 loopback 生效，`transport/server.js:788`） |
| 反向桥接不得自动获得 localUi | ✅ | `socket.data.aremote` 计入 `isTunnel`（`transport/server.js:816`），本地 token 信任分支被跳过；本地管理 HTTP API 不经中继暴露 |
| 限界/背压 | ✅ | 帧 8MB、发送缓冲 16MB（超限关会话）、每 Host 会话 64、总 WS 2048、ticket 4096、管理会话 100、pairings 1000、日志裁剪 1 万条、请求体 16KB（`shared/relay/protocol.js:3`、`relay.js:31,46,72` 等，均有测试） |
| 重连 | ✅ | 双向 WS ping/pong 心跳；Host 指数退避+抖动（`connector.js:23,52`），连接 >30s 重置退避；Server 重启后身份保留、会话重建、PTY daemon 保终端（集成测试实证）；离线输入不重放（客户端 socket.io 无重排队列，`RelayAdapter.js:10` `reconnection:false` + 工作区重试梯） |
| 静态路由路径监狱 | ✅ | `resolve + startsWith(root+"/")`（`app.js:144-148`）；穿越实测 404。附小缺陷 #7（畸形编码 500） |
| 管理面 | ✅ 基本达标 | scrypt+盐+timingSafeEqual（`auth.js`）；登录限流；管理页 CSP `'self'`、token 存 sessionStorage、全 `textContent` 渲染防 XSS；改密使全部管理会话过期（测试覆盖）。限流缺陷见 #6 |
| Host/Server URL 硬约束 | ✅ | 远程强制 HTTPS、禁 userinfo/path/query（`host/aremote/index.js:16-21`、`connector.js:6-8`、`web/shared/aremote/client.js:9-15`、Android 壳 launcher/`MainActivity` 均 https-only、`usesCleartextTraffic=false`） |
| 壳权限最小化 | ✅（配置级） | Tauri：无 plugins/无 invoke handler/无 capabilities 文件 → 无命令桥；Android：无 `addJavascriptInterface`、file/content access 关闭、混合内容禁止。**未真机验证** |

---

## 四、问题清单（按严重性排序）

### 高

1. **Docker/Compose 构建失败 —— S4 部署主路径不可交付**
   - 位置：`Dockerfile:7`（web 阶段 `node:24-bookworm-slim` 无 git）× `scripts/buildWebStatic.mjs:55`（`execSync("git init -q")` 为硬依赖；且 `:45-48` 每次构建先删除 mirror 中除 `.next` 外全部内容，`.git` 也被删，故 git 是**每次**构建的必需项，本地同理）
   - 触发：`docker compose up -d --build`（即 `deployment.md` 的主部署路径）
   - 后果：构建在 `[web 11/11]` 以 exit 127 失败（`/tmp/aremote-docker-build.log`）；Compose/TLS/持久卷整条链路无法交付。另注：默认 bridge 网络下宿主代理 `127.0.0.1:7890` 不可达属环境问题（`--network host` 可绕过），但缺 git 是 Dockerfile 自身缺陷
   - 建议：web 阶段 `apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*`；或改造脚本在无 git 时以其他方式约束 Tailwind 扫描范围（如显式 `@source`），消除对 git 的硬依赖

2. **已验证的工作树 ≠ 分支 HEAD，按文档部署得到的构建不在验收证据覆盖内**
   - 位置/证据：`git status` —— 未提交 `host/aremote/index.js`（配对码/注册密码出栈清除）、`web/app/layout.js`（GA 移除、Google Fonts `<link>` 改本地、上游 Expo 重定向移除）、`web/.env.production`（GA ID 清空）、`package-lock.json`（约 3 万行 npm 重生成）；未跟踪 `web/public/fonts/`（本地 Material Symbols）、`host/aremote/test/`（集成测试）、`docs/phase1/build.md`、`docs/phase1/deployment.md`
   - 触发：任何人按 `deployment.md` `git clone -b phase1/self-hosted-relay` 部署，或引用 CI run 40175042670 的产物
   - 后果：HEAD `968cd51` 的静态 UI 仍含 **Google Analytics（G-8XXG61NY56）与 Google Fonts CDN `<link>`**（`git show HEAD:web/app/layout.js:6-7,79,96`），与"自托管、无上游遥测"目标直接冲突；集成测试、本地字体、配对密钥出栈等修复均不在分支上；CI 跑的是 HEAD，与浏览器验证所用工作树构建不同源
   - 建议：提交工作树修复（lockfile 变更需复核后一并提交），在 HEAD 上重跑 CI 与产物哈希，再行验收

### 中

3. **静态导出被误判为 Host 环境，远程客户端产生持续 404 与错误的 Host 管理 UI**（详见 2.1）
   - 位置：`web/shared/utils/localOrigin.js:29`；受害点 `web/app/workspace/layout.js:1260`、`PendingDeviceApprovalModal.js:31,43`、`AgentDashboardView.js:630-704`、`logStore.js:53`
   - 建议：`isHostEnvironment()` 增加运行时判别（Host 静态服务注入标记 / 检查 `location.port === AGENT_PORT` / 探测 Host 专有端点），或 AREMOTE 模式下不挂载这些 Host 专用组件

4. **运行时外部依赖残留：Google Fonts 与 GitHub API**
   - 位置：`web/app/globals.css:1-2`（两条 `@import`，产物与浏览器日志双确认）；`web/shared/constants/github.js:3-7` + `useGithubStars`（挂于工作区常驻 `TerminalHeader.js:145`、`SlideMenu.js:29`）
   - 后果：自托管/离线场景每次加载向 Google/GitHub 泄露客户端 IP 与访问时序；断网时字体回退、star 数静默失败；GitHub 指向**上游** `decolua/9remote` 而非 fork
   - 建议：删除 globals.css 两条 `@import`，Inter 本地化（next/font 或 `/fonts`）；`useGithubStars` 在 AREMOTE 构建下直接返回占位（或指向自托管元数据端点）

5. **上游遗留管理页随静态导出可达**
   - 位置：`server/app.js:138` 仅接管精确 `/admin`；静态导出含 `web/out/admin/`（login/turn/ota/access，200 实测）、`/download` 等
   - 后果：死 UI + 上游品牌与 Turnstile 代码留在产物中；其中 `/admin/login` 恰好命中本 Server 的 `/api/admin/login`（同一认证后端），属巧合兼容而非设计——易误导运维
   - 建议：`buildWebStatic.mjs` 的 `SKIP_REL` 排除 `app/admin`、`app/download`、landing 专用路由，或在 Server 路由层对这些路径返回 404

6. **反代之后全局限流可被未认证流量打满（登录/注册可用性）**
   - 位置：`server/app.js:21-28`，限流键 `req.socket.remoteAddress`
   - 触发：Compose 部署下 Caddy→server，所有外部流量源 IP 均为 caddy 容器 IP；管理员登录、设备注册、改密共享同一 20 次/60s 桶
   - 后果：攻击者以 ≥20 req/min 即可长期占满桶，阻断合法管理员登录与新设备注册；同时"按 IP 限流"在该部署形态下失效
   - 建议：仅对已知代理跳数信任 `X-Forwarded-For`（或 Caddy 显式设置），或按"端点+凭证标识"分桶；管理登录可再叠加每账号惩罚

### 低

7. **畸形百分号编码返回 500 而非 400**
   - 位置：`server/app.js:144` `decodeURIComponent(path)` 未捕获 `URIError`
   - 复现：`curl http://127.0.0.1:PORT/%` → `{"error":"Internal server error"}` 500 + `request-error` 日志噪音（已实测）
   - 建议：捕获后 `fail(400, "Bad path")`

8. **同一设备重连复用关闭码 4003，与"凭证变更"语义混淆**
   - 位置：`server/relay.js:17-19`（`dropDevice` 对被替换的旧 Host 连接发 4003）× `host/aremote/connector.js:50-51`（收到 4003 视为凭证失效、**永久停止重连**）
   - 触发：同一 `device.json` 误启两个 Host 实例（或旧实例未停干净）
   - 后果：两个实例互相以 4003 踢掉对方 → 双方均永久停止，Host 离线直至人工重启；单实例正常重连时旧连接也会打出误导性的 `credentials-revoked` 日志
   - 建议：替换旧连接改用独立关闭码（如 4000/4008），仅 rotate/revoke 走 4003

9. **每个中继帧触发同步 SQLite 写**
   - 位置：`server/relay.js:73,95`（每帧 traffic 累加）、`:52`（每次 pong 更新 lastSeen）
   - 后果：WAL + 默认 synchronous=FULL 下，终端高频小帧 × 多会话会造成写放大，低配 VPS 可能成为吞吐瓶颈（统计口径本身符合设计文档"成功进入发送队列的应用 payload 字节"）
   - 建议：内存累计、按秒级定时刷库

10. **文档引用了不存在的 validation.md**
    - 位置：`docs/phase1/build.md:44`、`deployment.md:3` 均写"实际执行记录…见 validation.md"，`docs/phase1/` 无此文件（现有：audit-and-design / source-inventory / build / deployment）
    - 建议：补齐该文件（记录命令、版本、SHA256），本报告可作验收侧输入

11. **壳与分发的既知限制（记录在案，非新发现）**
    - Windows：EXE 未签名；`tauri.conf.json` `csp: null`（依赖远端 origin 自身响应头）；WebView2 走 downloadBootstrapper（目标机离线时无法补装）
    - Android：调试签名；无文件选择器/下载器/通知/相机扫描集成（`build.md` 已如实声明"需分别验收"）；返回键/菜单为最小实现
    - 均待 S5 真机验收

---

## 五、阶段验收门状态（区分四个层级）

| 阶段 | 源码实现 | 测试通过 | 产物构建 | 真实平台验收 |
| --- | --- | --- | --- | --- |
| S0 审计/来源 | ✅（audit 文档、fork/upstream remote 核实：origin=Ande-ZH/ARemote，upstream=decolua/9remote） | — | — | — |
| S1 Server/协议/身份/ACL | ✅ | ✅ 6/6（真实 WS 双向二进制、越权、撤销、轮换、心跳、背压、管理面无秘密泄露） | — | 部分（Node 直起 + 冒烟；Compose 未过） |
| S2 Host 反向中继 | ✅ | ✅ 集成测试（真实 PTY、文件往返、敏感路径拒绝、Server 重启恢复） | — | 部分（仅 Linux Host 实测；Windows/macOS Host 未测） |
| S3 Web 工作区接入 | ✅ | ✅ 浏览器验证（注册/授权/进 workspace/relay 会话）| ✅ `client:build` | 部分（浏览器未实际敲终端，终端 I/O 由集成测试覆盖；#3/#4 缺陷在此层） |
| S4 Docker/Compose/TLS | ✅（配置齐全） | — | ❌ **构建失败（缺 git）** | ❌ 未达 |
| S5 Android/Windows 壳 | ✅（最小壳、无命令桥、https-only） | — | ✅ CI 产物 + SHA256 | ❌ **未真机安装验收** |
| S6 文档/出站审查/收尾 | 部分（文档基本齐；validation.md 缺失；出站残留 #4/#5；HEAD 不一致 #2） | — | — | — |

---

## 六、结论

**Phase 1 验收：不通过（核心质量良好，存在两个阻断项）。**

成立的 部分（经独立复验）：共享协议/帧编码、SQLite 身份与 ACL、一次性配对码、票据制 WS 中继、Host 反向连接与身份接缝（不获得 localUi、无 SSRF、无上游出站）、Server 重启后 PTY 会话恢复、静态 Web 构建与登录/授权/中继全链路、CI 三平台产物。安全设计（默认拒绝 ACL、哈希存储、即时撤销、限界背压、路径监狱）在源码与测试两个层级均得到印证。

阻断项（通过验收前必须解决）：
1. Docker/Compose 构建失败（#1）——S4 未交付；
2. 验证证据基于工作树，而分支 HEAD/CI 产物仍含 GA 与 Google Fonts CDN 链接且缺少集成测试等修复（#2）——"按文档部署"与"被验证的构建"不同源。

应同批处理的中危项：#3 静态导出误判 Host 环境（持续 404 + 错误 UI）、#4 运行时外部依赖（Google Fonts / api.github.com）、#5 上游遗留页面、#6 反代下全局限流。

**尚未验证项（不因上述通过而隐含）：**
- APK/EXE 真机安装与日常使用（含 Android 键盘/文件选择、Windows WebView2 安装路径、长会话稳定性）；
- 公网 HTTPS 部署全链路：Caddy ACME 自动签发、非默认端口、已有证书模式（`Caddyfile.certificates`）、`ALLOWED_ORIGINS` 跨源场景；
- `server-data` 卷的备份/恢复演练（文档要求"恢复数据库而非重设设备身份"，未实操）；
- 弱网/断网长时间运行下的重连窗口表现、多 Host 多 Client 并发规模、#9 所述 SQLite 每帧写入在真实负载下的性能；
- Windows/macOS 上的 Host 运行时（本次仅 Linux 实测）；
- 浏览器端真实终端键入/文件管理器 UI 操作（本次由集成测试在协议层覆盖）。

---

*本报告为独立验收记录；引用的临时证据位于 `/tmp/aremote-*.log|.mjs`（会话产物，未纳入版本库）。审查过程中未改动任何源码；本机既有 `/root/.9remote` ptyDaemon（10 月 19 日起）为审查前已存在进程，未触碰。*
