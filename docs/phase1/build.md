# 构建与产物

## Web / Host / Server

Node.js 24。根目录和 server 分别提供 lockfile：

```bash
npm ci --ignore-scripts
npm rebuild node-pty
npm ci --prefix server --workspaces=false
npm run client:build
npm run server:test
node --test host/aremote/test/integration.test.js
```

Linux 浏览器端到端验证（使用独立工具目录，先构建 `web/out`）：

```bash
npm install --prefix /tmp/aremote-browser-tools --no-save --ignore-scripts playwright@1.64.1
node /tmp/aremote-browser-tools/node_modules/playwright/cli.js install --with-deps chromium
AREMOTE_PLAYWRIGHT_MODULE=/tmp/aremote-browser-tools/node_modules/playwright/index.mjs node scripts/validateBrowser.mjs
```

脚本临时启动独立 Server、Host 和 PTY，执行浏览器配对、终端键入、页面刷新、Server 重启恢复、编辑器保存，并拒绝外部网络请求。已有系统 Chromium 时可额外设置 `AREMOTE_BROWSER_EXECUTABLE=/usr/bin/chromium`。测试只操作临时目录，结束后清理测试进程和数据。

Web 静态导出保留原 workspace 组件，输出 `web/out`，构建镜像不包含旧 Worker API。Server 通过 `WEB_DIR` 提供它。Host 使用 `host/aremote/index.js`，不需要 upstream 云端的安装/发布流程。`--ignore-scripts` 避免运行原包发布安装钩子；PTY 原生模块单独构建。远程桌面截图/输入库在目标操作系统需要其对应原生依赖及桌面权限。

`docker compose build` 构建 Server 镜像，其中构建阶段包含 Web 工具链，运行阶段只有 Node、ws、Server、共享协议与静态 Web 文件。

## Windows EXE

保留上游使用的 Tauri 2 技术，新增薄 Client 壳 `client-shell`，不附带 Host sidecar。客户端加载用户指定 Server 的同一原 workspace UI，远程页面没有本地 shell/文件系统命令桥接。使用 Windows、Rust stable、MSVC Build Tools、WebView2：

```powershell
cd client-shell
npx --yes @tauri-apps/cli@2.12.4 build
```

输出 `client-shell/src-tauri/target/release/bundle/nsis/*.exe`。这是 Windows 安装程序，不是将网页文件改扩展名。初版未配置代码签名；WebView2 缺失时安装程序下载官方运行时。

## Android APK

上游公开源码不包含私有 Expo 工程；新增最小原生 WebView 壳，复用 Server 的 Web UI。没有原生 JS 命令桥接，不忽略 TLS 错误，不允许明文远程地址。要求 JDK 17、Gradle 8.9、Android SDK Platform 35 / Build Tools 35.0.0：

```bash
cd client-shell/android
gradle --no-daemon assembleDebug
```

输出 `app/build/outputs/apk/debug/app-debug.apk`，为可安装调试签名 APK。正式发布需要项目持有者管理稳定签名密钥；调试签名不用于商店正式分发。壳支持基础 WebView 输入/浏览；文件选择器、下载器、通知、相机扫描等原生集成需分别验收，不能由 APK 编译成功推导已完成。

## GitHub Actions

`.github/workflows/phase1.yml` 配置了 Server 测试、Host/浏览器集成验证、Web 导出、Docker、Android 和 Windows 构建；可在 Fork 的开发分支运行 workflow_dispatch。产物在对应运行的 Artifacts 下载，不依赖上游官方服务。实际执行记录、版本和 SHA256 见 validation.md。
