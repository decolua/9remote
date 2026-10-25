# Phase 1 验证记录

更新：2026-10-26（Asia/Shanghai）。当前分支 `phase1/self-hosted-relay`，提交基线 `968cd51de64c0a0c88280b7628e33efd454a02d8`，另有未提交改动。本记录只声明已实际执行的项目，Phase 1 整体验收尚未通过。

## 已执行的本地验证

环境：Linux、Node.js `v24.21.0`、Docker Engine `26.1.5+dfsg1`、Compose `2.26.1-4`。

| 项目 | 命令 / 操作 | 结果与边界 |
| --- | --- | --- |
| Server | `npm run server:test` | 9 项通过：认证、一次性配对、ACL、真实 WS 文本/二进制、路由隔离、流量、撤销、轮换、密码持久化、心跳清理、缓冲限制、可信代理限流、静态路由与重复 Host 替换。 |
| 原 Host 集成 | `node --test host/aremote/test/integration.test.js` | 1 项通过：真实 Host/PTY 与 Socket.IO ACK、UTF-8 文件写入/读取、`/etc/shadow` 拒绝、Server 重启后原终端重新加入及输入输出恢复。 |
| Web 构建 | `npm run client:build` | 最终静态导出成功，输出 `web/out`；不包含旧 Worker API、管理和下载页面。构建时仍使用 `next/font/google` 获取 Geist，运行时由本机提供字体。 |
| 浏览器端到端 | `scripts/validateBrowser.mjs`，Chromium + Playwright 1.64.1 | 真实配对和 ACL、创建终端并键入、刷新恢复、Server 重启后再次键入、直接进入编辑器并保存到 Host 文件均通过。无外部网络请求、未捕获 JS 异常及正常运行期间的 HTTP 错误；刻意重启窗口的一次预期 `/api/tickets` 503 单独记录。 |
| 定向 lint | 对修改过的 JS/MJS 执行 ESLint，并与 HEAD 同文件比较 | workspace/layout 有原有 5 个 `react-hooks/set-state-in-effect` error 和 6 个 warning；HEAD 和修改后数量一致。根 layout 原有手动 stylesheet link 有 1 个 warning；其他检查文件无 error。不能声明整个仓库 lint 全通过。 |
| Diff 格式 | `git diff --check` | 通过。 |

浏览器和首轮独立审查发现的问题已修复并验证：

- Google CSS 与 GitHub stars 运行时请求已移除或在 ARemote 模式关闭，本地提供图标字体。
- 静态导出的 ARemote 环境不再误判为本地 Host，停止请求本地管理 API。
- 新终端路由改用已导出的 `default?session=...`，修复创建终端后 404；旧终端链接可重定向。
- 工作区等待连接就绪后挂载文件/编辑器视图，修复直接进入编辑器时过早读取而停留在 Not connected 的问题；临时断线后保留已挂载视图。
- 旧云管理和下载页面不再导出或由 Server 静态路由暴露；非法 URL 返回 400。
- 可信代理后按客户端分别限流，独立 Node 默认忽略转发头。重复 Host 使用独立替换关闭码，新连接保留、旧实例停止重试；不同于凭证撤销。

复现命令见 [build.md](build.md)。本次浏览器命令：

```bash
AREMOTE_PLAYWRIGHT_MODULE=/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs AREMOTE_BROWSER_EXECUTABLE=/usr/bin/chromium node scripts/validateBrowser.mjs
```

临时日志：`/tmp/aremote-server-test-fixed.log`、`/tmp/aremote-host-test-fixed.log`、`/tmp/aremote-client-build-final.log`、`/tmp/aremote-browser-e2e.log`、`/tmp/aremote-lint-final.log`。这些是当次环境的记录，不是版本库内可长期依赖的产物。

## Docker

`docker build -t aremote/server:phase1-validation .` 首次在 npm 下载阶段失败：本机 Docker 代理配置指向容器内不可达的 `127.0.0.1:7890`。

随后发现并修复 Docker 构建阶段缺少 Git 的真实阻断。最终 `docker build --network host -t aremote/server:phase1-validation .` 成功，镜像 ID：

`sha256:6942318dd007564fdb3abbf2163c0f87666264cdd3c8fa2f5a539dc0b90fbe7e`

使用实际 `compose.yaml` 与临时测试覆盖配置，映射到 loopback 随机端口、独立项目和卷，执行了 Caddy HTTPS 验证。客户端显式信任生成的本地 CA，没有禁用证书校验。实际通过：`/health`、管理登录、Host/Client 配对及 ACL、静态登录和终端路由，以及 Server 重启和强制重建后设备凭证/ACL 持久化。测试资源已清理，没有操作已有生产卷。**这不是公网域名的 ACME 签发或外网实机验收。**

环境故障另行记录：宿主盘满曾导致测试数据库写入失败；清理本次旧构建缓存后恢复。Docker 自动注入的代理 `127.0.0.1:7890` 导致 Caddy 反代 502，在测试覆盖配置中清空容器代理后通过，未改动生产源配置。日志：`/tmp/aremote-docker-build-final.log`、`/tmp/aremote-compose-validation.log`；本地测试脚本 `/tmp/aremote-compose-validation.py`。

## Windows / Android 构建证据

[GitHub Actions run 40175042670](https://github.com/Ande-ZH/ARemote/actions/runs/40175042670)，提交 `968cd51de64c0a0c88280b7628e33efd454a02d8`。通过 GitHub API 核实 `server`、`android`、`windows` 三个 job 均为 success，两个安装包 artifact 均未过期。该结果仅覆盖该提交及对应 CI 命令，未覆盖当前未提交改动、Web 构建或 Host 集成测试。

本目录已有产物及本地计算的 SHA256：

| 产物 | SHA256 |
| --- | --- |
| `artifacts/android/app-debug.apk` | `029fddc6077c7a79a5f2ddbc648831cce4291dc1fc6e281d0fcdf376be53e6dc` |
| `artifacts/windows/ARemote_0.1.0_x64-setup.exe` | `19acc63c565dd1240206b8e70a6e2c50b2926a651784cda672caf6c4912026f0` |

本地确认 APK 是包含 Manifest、DEX 与 launcher assets 的 ZIP/APK，EXE 有有效的 MZ/PE 文件头。尚未在 Android 真机或 Windows 上安装、登录、执行终端及文件操作，不能据此声明平台功能验收通过。产物目录由 `.gitignore` 排除。

## 独立验收与续接

按用户要求，复用本目录已经打开且待命的 **Claude Code 前台会话 `Claude 2`**，当前模型 `glm-5.3[1M]`，执行独立验收。没有使用后台 agent。此前误新开的 Claude print 实例已停止。

- 现有终端：`session-1792956172804`，TTY `/dev/pts/8`；进程和 TTY 可能随重启改变，续接前重新确认目录和模型。
- Claude 对话 ID：`2264381d-345b-4c16-b402-ca70fdbeb546`。
- 任务要求只读审查与必要本地测试，仅允许写验收报告 `docs/phase1/acceptance-claude-glm53.md`。
- 首轮报告：[acceptance-claude-glm53.md](acceptance-claude-glm53.md)，结论为未通过；该报告保留修复前快照，不改写历史。
- 第二轮报告：[acceptance-claude-glm53-recheck.md](acceptance-claude-glm53-recheck.md)。同一前台会话已独立重跑浏览器端到端、Server 9 项和 Host 集成 1 项，全部通过，并核实 Web/Docker/Compose 日志和产物。复验结论为核心功能与本地部署链路达标，整体 Phase 1 尚不能宣称全部通过；源码只读，未提交或推送，前台会话保留。
- 复验纠正首轮 #8 的过度推断：原重复 Host 行为也是最新实例获胜，并非两个实例双双离线；实际修复是独立替换关闭码和准确状态提示。

## 当前边界与待办

- 当前修复仍在本地工作区，未提交或推送；基线 CI 不代表当前修复已在 Actions 运行。新增 Host/浏览器/Web/Docker CI 项目尚待实际执行。
- Android 真机、Windows 安装和 WebView2、macOS/Windows Host、远程桌面捕获与输入仍需对应环境验收；公网 ACME 签发未测。
- 仍未做大流量压力测试，Relay 每帧同步统计的开销尚未量化。
- 构建阶段下载 npm 依赖和 Geist 字体需要外网；运行时端到端测试未发现外部请求，不能将其解释为所有功能均已完成出站审计。
- 不能将本次 Linux 浏览器与 Compose 验证等同于 Phase 1 全平台验收通过。以复验报告的实际发现继续跟进。
