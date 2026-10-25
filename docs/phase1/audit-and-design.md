# Phase 1 源码审计、迁移设计与实施顺序

基线：9Remote `29ff890d6c96b60996fd2e4a9331c00198556ed6`，版本 3.0.43。
来源：https://github.com/decolua/9remote；Fork：https://github.com/Ande-ZH/ARemote。
保留 LICENSE（Apache-2.0）、Git 历史和 NOTICE。修改上游文件时标明 ARemote 修改。
本文是实施基线，不代表所有验收项已通过。逐文件检索见 [source-inventory.md](source-inventory.md)。

## 1. 技术架构与目录

| 目录 | 技术与职责 | 迁移边界 |
| --- | --- | --- |
| `host/index.js`, `host/api`, `host/lib` | Node.js HTTP、本地管理 API、设备许可、平台能力 | 保留功能；增加独立启动入口和 Relay 身份入口 |
| `host/cli` | CLI/TUI、服务生命周期、配对、更新、cloudflared 下载启动 | 替换联网生命周期，不能从旧 CLI 隐式启动官方服务 |
| `host/transport` | Socket.IO、node-datachannel、Connection 状态机、HostBus、codec、协议选择 | 复用 Socket.IO 帧，禁止中继把客户端当成本地管理员 |
| `host/features/terminal` | 持久 PTY daemon、键盘、resize、终端会话 | 保留；测试真实 PTY，不用 echo 替代验收 |
| `host/features/ai` | 多种 CLI 适配器、进程/RPC、会话、工具事件 | 原样保留，外部 Agent 仍由用户安装 |
| `host/features/fileExplorer` | 文件/Git、传输 ACK、分块、路径限制 | 保留 `pathGuard` 和原有传输协议 |
| `host/features/remote`, `browser`, `mobile` | 桌面捕获、分块视频、浏览器、模拟器、输入 | 复用 WS 降级通道；不同平台须实测，不能声称保持 P2P 延迟 |
| `web/app`, `web/features`, `web/shared` | Next.js 16、React 19、Zustand、xterm、CodeMirror | 保留 workspace/UI；替换登录和地址发现 |
| `web/app/api`, `web/durable-objects` | Worker 中的认证、D1、信令、OTA、订阅 | 新 Server 接管基础认证/注册/状态；旧云路由不进入部署 |
| `web/migrations` | D1 会话、管理员、OTA、IAP 等 schema | 新设备凭证和 ACL 不是旧短码表的简单复制 |
| `desktop` | Tauri 2 / Rust、Host sidecar、托盘、官方 updater | 保留参考；Client 壳与 Host sidecar 生命周期分离 |
| `scripts` | esbuild、静态 Web 镜像构建、版本同步、发布 | 复用静态导出，移除部署路径的 Worker 初始化 |
| `gitbook` | Next 文档站、Cloudflare Pages 部署 | 用 Markdown 提供自托管文档，不作为运行依赖 |

根目录 npm workspaces 包含 host/web/gitbook/desktop，没有 lockfile。源码实际有 226 个 Host/Web 测试文件，CLAUDE.md 的“无测试”描述已过时。文档所述 `expo/` 不在此提交中；不能沿用不存在的 Android 工程。构建环境当前有 Node 24、Git、gh、Docker CLI，无 cargo/flutter（后续另查 Android SDK/JDK 与 daemon）。

原数据流：Host CLI 创建/续期 Worker session → 启动 quick tunnel → 上报 tunnelUrl → Client 调用 Worker `/api/connect` → Socket.IO 经 tunnel 到 Host；并行通过 SignalingDO 交换 WebRTC 信令。D1 负责元数据，实际终端/文件/屏幕由 Host 提供。Host 还有本地管理 HTTP API，这些 API 不应通过新 Relay 暴露。

## 2. Cloudflare 依赖及替代

| 能力 | 证据位置 | ARemote 替代 |
| --- | --- | --- |
| Tunnel 下载/启动/重启 | `host/cli/utils/cloudflared.js`, `host/cli/tunnel/manager.js`, `host/cli/modes/*` | Host 主动 WSS 长连接，不开放公网入站端口 |
| Workers/OpenNext | `web/next.config.mjs`, `web/package.json`, `web/scripts/inject*.mjs` | Node Server + 静态导出的原 Web UI |
| D1 注册、短码、心跳、管理 | `web/app/api/*`, `web/shared/utils/db.js`, `web/migrations/*` | 持久 SQLite；设备、ACL、管理员会话、日志独立 schema |
| Durable Objects | `web/durable-objects/SignalingDO.js`, 两端 `SignalingClient.js` | 单 Server 内存连接索引 + WS 心跳；持久元数据存 SQLite |
| KV / R2 OTA | `web/features/ota`, `web/app/api/ota`, wrangler OTA_KV/R2_PUBLIC_BASE | Phase 1 关闭官方 OTA；发布自有 APK/EXE，后续自托管更新 |
| TURN API | `web/features/admin/lib/turnKeys.js`, `/api/webrtc/turn-credentials` | Phase 1 禁用 RTC/TURN，WS 为唯一远程承载 |
| Turnstile | admin TurnstileWidget / turnstile.js | 本地密码哈希、登录限流、会话过期 |
| Worker Rate Limiting | LOGIN_RATE_LIMITER, `web/shared/utils/rateLimit.js` | Server 有界限流计数器 |
| Cron / 历史隧道和 DNS 清理 | `/api/cleanup`, `tunnelService.js` | 本地清理任务；不调用 Cloudflare 管理 API |
| 官方地址及更新 | 两端 API/config、next.config、desktop updater、OTA 常量 | 自定义 origin/端口；禁止缺省回退官方服务 |
| Pages 文档 | `gitbook/wrangler.toml`, 根 docs:deploy | 本地部署文档，无运行时依赖 |

保留历史源码用于 upstream 合并不等于运行时保留依赖。验收需要对实际启动/构建路径和浏览器联网做检查，单纯 `rg` 无命中不是充分条件。

## 3. 功能保留与迁移

- 原样复用：终端渲染、PTY daemon、Agent 适配器、文件编辑/传输、Git、会话布局、快捷键、剪贴板、浏览器和桌面处理器。
- 适配：登录、设备发现、连接状态、断线恢复、Host 启动、设备授权、服务器地址、打包名称与发布源。
- 替换：云认证与短码、隧道、信令中心、管理后台数据源、在线/流量统计。
- Phase 1 不启用：P2P/TURN、官方 OTA/IAP/云管理；不把这些状态伪装成已迁移。
- 原路径安全、本地 API 隔离、会话销毁必须保留；从反向桥接到 loopback 的连接不能凭 IP 自动获得 localUi 权限。

## 4. 三端与通信协议 v1

`server/`：HTTP 管理与设备 API、SQLite、管理员密码/登录、注册凭证/一次性配对码、设备 ACL、WS Relay、指标和日志。
`host/aremote/`：注册与私有凭证文件、主动连接、心跳/重连、复用原 Host 服务的 Socket.IO 承载。
`shared/relay/`：无 Cloudflare 的共享协议常量、校验和帧编码；Host/Server 使用同一实现。
`web/`：保留 workspace，新增服务器选择/设备登录/Host 列表，Socket.IO 通过 Server 中继。

管理员通过 HTTPS 密码登录，密码以 scrypt 盐化哈希存储。注册通过单独注册密码或一次性配对码，每设备签发随机凭证，仅哈希存 Server。Client/Host 角色不能互换。Client 到 Host 使用显式 ACL，默认拒绝；撤销/轮换立即关闭旧连接。

Host 向 `/relay/host` 发起 WS，凭证在 Authorization 头中，协商版本 `aremote.v1`。一个 Host 控制连接复用多个会话。Client 先用设备凭证申请短时、一次性连接票据，再用票据连接 `/relay/client`；永久凭证不得出现在 URL。每会话用随机 ID，Server 根据已认证身份创建路由，拒绝跨 Host/会话注入。中继保留 Socket.IO / Engine.IO 文本、二进制帧及 ACK，不自行解释 Agent 命令。

控制消息：`open`（sessionId、clientId）、`ready`、`close`。数据帧带版本、sessionId、原帧文本/二进制标记及 payload。具体编码及上限以共享模块为准。Client 不允许选择任意目标 URL/端口；Host 只连接自己的固定 loopback Socket.IO 端点，不能成为通用 SSRF 代理。

WS ping/pong 检测死连接；Host 使用指数退避和抖动重连。Server 重启后设备身份保留、在线状态重新建立，旧 Relay session 关闭；Client 重建会话，PTY daemon 保留终端，不重放离线命令。连接/队列/帧大小须有上限，慢接收方超限关闭对应会话并显示错误，不能无限缓存。统计定义为成功进入中继发送队列的应用 payload 字节，不包括 TLS/TCP 开销、不声称接收端已消费。

## 5. 实施顺序、依赖和验收门

1. S0：固定源码、来源/许可证、依赖与功能审计（本文）；Fork/remote 验证。
2. S1（依赖 S0）：共享协议、SQLite 身份/ACL/配对、Relay、API、管理页；用真实 WS 测试双向二进制、越权、撤销、轮换、心跳、背压及清理。
3. S2（依赖 S1）：Host 反向连接和原 transport 鉴权接缝；真实 Socket.IO/PTY/文件测试；Server 重启自动恢复。
4. S3（依赖 S2）：原 Client workspace 接入；测试浏览器登录、授权 Host 选择、终端输入、文件读写、断线提示。
5. S4（依赖 S1/S3）：Docker/Compose、Caddy 自动 TLS/用户证书、持久卷和端口配置；实际构建、重启、无 Cloudflare 配置启动。
6. S5（依赖 S3）：Android/Windows 壳与构建；用真实 APK/EXE 产物、SHA256 和安装测试记录验收，CI 配置本身不算构建成功。
7. S6（依赖全部）：安装/部署/构建文档、网络出站审查、兼容性回归和剩余限制；逐条更新验收状态。

各阶段记录实际命令、结果和环境阻塞。源码实现、集成通过、平台构建通过、真机验收分别记录，不能互相代替。
