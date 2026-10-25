# ARemote Phase 1 第二轮定向复验报告

- 日期：2026-10-26（第一轮验收后）
- 方式：同前台会话，模型 GLM-5.3（1M），未开新会话、未委派子代理
- 范围：仅审查第一轮后的修复增量 + 新增 `scripts/validateBrowser.mjs`、`server/test/http.test.js`；未重扫上游全量
- 约束遵守：源码只读，仅写入本报告；未 commit/push；未重复完整 Docker/Web 构建；复验产生的临时进程/目录已清理（`validateBrowser.mjs` 自带清理，已核实无 `/tmp/aremote-browser-*`/`aremote-integration-*` 残留目录与 chromium/ptyDaemon 残留进程；`/tmp` 下既有用户证据日志未动）

---

## 一、独立复跑结果（全部本机重跑）

| 项目 | 结果 |
| --- | --- |
| `AREMOTE_PLAYWRIGHT_MODULE=… AREMOTE_BROWSER_EXECUTABLE=/usr/bin/chromium node scripts/validateBrowser.mjs` | ✅ **PASS**：配对/ACL、真实终端键入（xterm 中 `printf` 标记回显）、刷新后会话保持并继续键入、Server 重启后继续键入、编辑器读取原文并 Ctrl+S 后**磁盘内容逐字一致**；外部请求 0、JS 错误 0、HTTP 失败 0（仅刻意重启窗口内 1 次预期 `/api/tickets` 503，单独计数） |
| `npm run server:test` | ✅ **9/9 通过**（含新增"可信代理分桶+直连防伪造"与"静态路由排除/400/302"两项） |
| `node --test host/aremote/test/integration.test.js` | ✅ 1/1 通过（19.0s，含 Server 重启后原终端恢复） |

审阅既有证据（未重跑，按用户指示）：
- `/tmp/aremote-client-build-final.log`：最终 Web 构建成功；产物核实：`web/out` **无** `admin/`、`download/`，`workspace/terminal/` 仅 `default*`，CSS 中**无** `fonts.googleapis`，`_next/static/media/` 有 11 个自托管 woff2。
- `/tmp/aremote-docker-build-final.log` + `docker images`：构建成功，镜像 `sha256:6942318dd007564fdb3abbf2163c0f87666264cdd3c8fa2f5a539dc0b90fbe7e`（本地现存，248MB，与声称一致）。
- `/tmp/aremote-compose-validation.log`：末尾 **PASS**（真实 `compose.yaml` + Caddy 本地 CA HTTPS、静态页、管理配对与 ACL、Server restart / force-recreate 后设备凭证与 ACL 持久化；容器与卷已清理）。按用户说明：验证客户端显式信任本地 CA、**未跳过 TLS 校验**；宿主 Docker 自动注入的代理导致 Caddy 502，经**仅测试用 override** 清除容器代理后通过——属环境问题处置，未改生产配置；**这是本地可信 CA 验证，不是公网域名 ACME 签发验收**。
- CI（`gh run list` 核实）：分支最新 run 仍为 40175042670（968cd51，旧配置三 job）；新 workflow（新增 integration/web/browser 与 docker job）**尚未运行**——与用户声明一致。

---

## 二、第一轮问题逐项判定

| # | 初验问题 | 判定 | 复验依据 |
| --- | --- | --- | --- |
| 1 | Docker 构建缺 git（S4 阻断） | ✅ **已修复** | `Dockerfile:3` web 阶段 `apt-get install -y --no-install-recommends git ca-certificates`；最终构建成功、镜像哈希核实 |
| 2 | 验证证据与分支 HEAD 不同源（未提交） | ⚠️ **未解决（交付项，用户已声明）** | 工作树仍全部未提交（23 个修改 + 7 个未跟踪，含本报告允许写入的文档）；新 CI 配置在未推送的改动中且未运行。`validation.md` 已如实记载此边界。**不得在提交+CI 重跑前宣称交付完成** |
| 3 | 静态导出误判 Host 环境 | ✅ **已修复** | `web/shared/utils/localOrigin.js:26` `if (AREMOTE) return false;`（首行短路）；运行时证明：浏览器脚本断言 Pair Device 按钮计数为 0、全程无 404 失败请求（此前的 `/api/ui/events`、`/api/device/pending` 404 消失） |
| 4 | Google Fonts / api.github.com 运行时请求 | ✅ **已修复（运行时）** | `web/app/globals.css:1` 两条 `@import` 已删，body 改用本地 `--font-geist-sans`（next/font 构建期自托管，产物含 11 个 woff2）；`useGithubStars.js:20` `if (AREMOTE \|\| !SHOW_GITHUB_STAR) return;` 且 `SHOW_GITHUB_STAR=false`（双保险）；浏览器脚本 external=0 实证。残留见"四、边界"第 1、2 条 |
| 5 | 上游遗留 admin/download 页面可达 | ✅ **已修复** | `scripts/buildWebStatic.mjs:26` `SKIP_REL` 排除 `app/api|admin|download`；`server/app.js:148` 对 `/admin`、`/download`（含 `/*.html`、`*.txt`、编码变体 `/ad%6din/`）一律 404；产物无这些目录；测试覆盖 |
| 6 | 反代后全局限流可被打满 | ✅ **已修复** | `server/index.js:4` `TRUST_PROXY === "1"` 默认关闭；`compose.yaml` 显式 `TRUST_PROXY: "1"`；两个 Caddyfile `header_up X-Forwarded-For {remote_host}` **替换**（而非追加）客户端可伪造头；`app.js:23-26` 取 XFF 末值+`isIP` 校验，键改为 `IP:端点路径` 分桶。测试证明：信任模式下不同客户端 IP 各自分桶（.10 被限流时 .11 仍可登录）；直连模式忽略 XFF（伪造不同 IP 仍共享 socket 桶被 429）。发布端口仅 Caddy（server 容器无 ports），直接打到 server 容器需已在内网 |
| 7 | 畸形编码返回 500 | ✅ **已修复** | `app.js:147` `try/catch → fail(400, "Bad path")`；测试 `/%` → 400 |
| 8 | 替换旧连接复用关闭码 4003 | ✅ **已修复**（并纠正初验过度结论，见下） | `protocol.js:4` `CLOSE_CODES = { replaced: 4001, credentials: 4003 }`；`relay.js:57` onHost 用 4001 "Host connected elsewhere"，rotate/revoke 仍 4003；`connector.js:51` 4001 → `host-replaced` 状态并停止争抢。新测试：旧连接收 4001、新连接保持 OPEN、hosts.size=1、admin 状态在线 |
| 9 | 每帧 SQLite 同步写（性能） | ⏸ **本轮未处理**（低危积压，符合预期范围） | `relay.js` traffic/seen 逻辑未变 |
| 10 | validation.md 缺失 | ✅ **已创建**（初验时是快照前状态） | 内容审阅：如实记录命令、结果、边界（lint 仅定向、CI 覆盖边界、真机未测、本地 CA 非公网 ACME、代理与盘满为环境故障）；用户说明正在同步 Compose 最终证据，以同步后版本为准 |
| 11 | 壳签名/集成限制 | ⏸ **平台未验收**（无变化） | 无新证据 |

**初验 #8 结论纠正（自查）**：初验称"两个实例互相踢导致双双永久离线"——该推断**缺少复现且不成立**：原实现中 `onHost` 先 `dropDevice` 关旧再注册新连接，语义是**最新实例获胜**，旧实例收到 4003 后停止的是自己（新实例不受影响）；唯一实际影响是日志误导与旧实例误报"凭证失效"。本轮已用独立关闭码把语义显式化并加测试。复验确认新行为正确。

### 本轮用户自报的两个新阻断（真实浏览器发现）

| 问题 | 判定 | 复验依据 |
| --- | --- | --- |
| 终端动态 session 路由在静态导出中不存在 → 新建终端后 404 | ✅ **已修复** | `routeConfig.js:4,10-14`：静态客户端生成 `/workspace/terminal/default?session=ID`，`pathToView` 在 `idPart==="default"` 时读 `?session=`（仅静态构建启用）；`server/app.js:149-155` 将旧式 `/workspace/terminal/<id>` 302 到新形式（保留其余 query），Host 自身静态服务本就有 `default.txt` 兜底（`host/index.js:411`，未改动）。浏览器实证：新建终端 URL 带 session → reload 后 session 参数一致 → 继续键入成功；http.test 断言 302 与 Location |
| 首次刷新直接进编辑器在连接前读文件 → 永久 "Not connected" | ✅ **已修复** | `workspace/layout.js:936` `isInitializing` 增加 `!everConnected` 条件（首连前不挂载数据视图）；`:1160,1196,1214` 文件/编辑器/Git 视图增加 `admitted` 门控。`admitted` 为粘性状态（`connectionStore.js:25`，仅 re-key 重置），短暂断线不卸载已挂载编辑器。浏览器实证：直进编辑器显示原文、Ctrl+S 后磁盘内容一致 |

---

## 三、增量代码审查意见（新改动的独立审查）

1. **限流键的 URL 解析**（`app.js:25`）：`new URL(req.url, …).pathname` 对 asterisk-form/absolute-form 请求目标均不抛错（已核），无崩溃面。✔
2. **302 重定向**：session 值经 `URLSearchParams.set` 规范编码，路径段先经 `[^/]+` 与解码后校验，`%2F` 注入只会落入 404 静态分支。✔
3. **XFF 末值取法**：Caddy `header_up` 为整体替换（单值），取 `.at(-1)` 与链式追加约定一致，即使未来前置第二层代理也取最近可信跳。✔
4. **`admitted` 门控范围**：桌面 files/editor/git 面板与移动 FileExplorer/GitPanel 均已门控；终端视图本就依赖连接。`everConnected` 来自 connectionStore，re-key（换 Host）时随连接重置，行为自洽。✔
5. **`isHostEnvironment()` 在 AREMOTE 构建恒为 false 的连带影响**（设计后果，非缺陷，建议知悉）：Host 本机浏览器打开 `http://127.0.0.1:2208` 得到的也是 ARemote 登录页，且该页预填的 `window.location.origin`（Host 本地 API）没有 `/api/devices/*` 路由，注册会失败——需手动输入 Server 地址。ARemote 模式下 Host 本地 Web 工作区不再直连（一律走中继），与 Phase 1 设计一致，但与上游行为不同，值得在部署文档加一句说明。
6. **useGithubStars 改写**：`AREMOTE` 构建下 effect 直接返回，fetch 代码仍在包内但不可达；非 AREMOTE（假想的云构建）受 `SHOW_GITHUB_STAR=false` 总开关约束。✔
7. **Docker web 阶段**仍需构建期网络（npm ci、next/font 拉取 Geist、git 元数据）：见"边界"第 1 条。

---

## 四、剩余边界与未完成项（如实，不因修复而隐没）

1. **构建期外部依赖仍在**：`web/app/layout.js:2` `next/font/google` 在构建时从 Google Fonts 拉取 Geist（运行时自托管，无泄露）。完全气隙环境无法构建 Web；CI runner 与本机构建均可达，故不阻断。`validation.md` 已如实记载。
2. **产物中残留 GitHub 常量**：`chunks/8026-*.js` 仍含 `api.github.com`/`repos/decolua/9remote` 字符串——属 **Codespace 集成功能**（用户主动使用且需 PAT 才会发起请求），非自动运行时依赖；浏览器脚本 external=0 实证无自动请求。品牌层面仍指向上游仓库。
3. **Compose 验证边界**：本地可信 CA + loopback 随机端口 + 独立项目/卷；**非公网域名 ACME 自动签发、非外网实机**。宿主代理注入与盘满属环境故障，已用仅测试 override 处置，生产配置未动。
4. **交付未闭环**：全部修复仍在未提交工作树；新 CI 配置（integration/web/browser/docker job）未运行。提交 → 推送 → CI 全绿 → 产物哈希更新之前，"按文档部署得到被验证构建"仍不成立（初验 #2 的核心）。
5. **平台未验收**：Windows/Android 真机安装与使用（键盘、文件选择器、下载、长会话）、Windows/macOS Host 运行时、`ALLOWED_ORIGINS` 跨源实测、弱网/长跑/并发规模、`server-data` 卷备份恢复演练、每帧 SQLite 写性能（初验 #9 积压）。

---

## 五、复验结论

- **第一轮列出的高/中危问题：全部确认修复**（#1、#3、#4、#5、#6、#7、#8 及两个用户自报新阻断），且均经我独立复跑或产物/日志核实，非仅凭代码审阅；#10 文档已补；#9 未处理（低危积压）。
- **初验 #8 的"双实例永久离线"表述系过度推断，予以纠正**：原语义为最新实例获胜；现行为已显式化并加测试。
- **Phase 1 整体状态：核心功能与部署链路（本地范围）达标；不得宣称整体全部通过**——剩余未完成项为：工作树未提交、新 CI 未运行（交付闭环），公网 ACME/外网实机，Windows/Android 真机验收，及"边界与未完成项"所列观察项。
- 初验报告 `acceptance-claude-glm53.md` 按约定保留未覆盖，其结论以本报告为最新修正。

*复验产生的临时资源已清理；用户既有 `/tmp` 证据文件与前台会话未受影响。*
