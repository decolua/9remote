# ARemote 安装与部署

开发分支：`phase1/self-hosted-relay`。此文描述部署接口，实际验收结果见 validation.md；未通过项目不能仅根据本文视作已交付。

## Server：Docker Compose

需要 Docker Engine、Compose v2、一个指向 Server 的域名；Client/Host 无需公网地址。Server 必须能被两端访问。

```bash
git clone -b phase1/self-hosted-relay https://github.com/Ande-ZH/ARemote.git
cd ARemote
cp .env.example .env
# 编辑 .env，设置 AREMOTE_DOMAIN 和独立随机 ADMIN_PASSWORD（至少 12 字符）
docker compose up -d --build
docker compose ps
```

访问 `https://你的域名/admin`。默认通过 Caddy 自动申请证书，Server 不直接公开 HTTP 端口。自动证书需外部可达的 80/443 端口及正确 DNS；改用其他外部端口时，须保证 ACME 验证路径仍可达或使用已有证书。

已有证书：将完整链及私钥放入 `deploy/certs/fullchain.pem`、`deploy/certs/privkey.pem`；`.env` 设置 `CADDYFILE=./deploy/Caddyfile.certificates`。证书目录已忽略，不提交私钥。自签证书必须先安装到 Client/Host 的信任链，不禁用 TLS 校验。

`HTTPS_PORT`/`HTTP_PORT` 控制公网映射端口；Client 的 Server 地址须包括非默认端口。Node 独立部署支持 `PORT`/`BIND_ADDRESS`，Compose 内部固定 8080。

本次本地验证遇到 Docker 客户端自动注入 `127.0.0.1:7890` 代理：构建阶段 npm 下载失败，Caddy 反代也返回 502（日志为 `proxyconnect ... connection refused`）。如使用代理，确保容器能访问该地址，并在 `NO_PROXY`/`no_proxy` 中包含内部服务名 `server`；本地测试通过临时 Compose 覆盖配置清空 Caddy 的代理变量后恢复。构建阶段可按实际网络配置代理；本次 Linux 环境使用 `docker build --network host`，这不是通用部署要求。

`server-data` 保存 SQLite、设备凭证哈希、ACL、密码哈希及累计流量；`caddy-data` 保存证书。普通 `docker compose down` 不清除数据；不要用 `down -v` 做常规更新。备份时停止 Server 再备份该卷，恢复时一并恢复数据库而不是重设设备身份。管理员首次密码由 `ADMIN_PASSWORD` 初始化，以后修改环境变量不覆盖已持久化密码；后台修改密码会使全部管理登录过期。

`REGISTRATION_PASSWORD` 可选，供 Client/Host 注册使用，与管理员密码独立。默认使用管理员生成的一次性配对码。注册密码只用于首次签发，设备重连使用独立 token。配对码仅显示一次、10 分钟过期、使用后立即作废。Client 注册后默认没有任何 Host 权限。

## Host：复用上游运行时

需要 Node.js 24、npm、平台原生构建工具（Linux 通常需要 Python3/make/g++）。Agent CLI 由用户安装并登录。桌面控制还需要系统图形会话及相应授权。

```bash
npm ci --ignore-scripts
npm rebuild node-pty
npm ci --prefix server --workspaces=false
```

注册一次（从管理后台选择 Host 生成配对码；避免把凭证写进 shell 历史）：

```bash
export AREMOTE_SERVER_URL=https://remote.example.com
read -rsp 'Host 配对码: ' AREMOTE_PAIRING_CODE; echo
export AREMOTE_PAIRING_CODE
node host/aremote/index.js register
unset AREMOTE_PAIRING_CODE
node host/aremote/index.js start
```

或通过 `AREMOTE_REGISTRATION_PASSWORD` 注册。`AREMOTE_NAME` 自定义设备名称，`AREMOTE_HOME` 自定义配置目录（默认 `~/.aremote`）。`device.json` 权限为 0600，保存 Server、设备 ID 和独立凭证；`PORT` 控制 Host 本地监听端口，默认 2208，ARemote 模式仅绑定 127.0.0.1。不要启动原 `9remote` CLI 来代替上述 ARemote 入口，否则会走上游联网流程。

轮换：`node host/aremote/index.js rotate`，然后重启 Host 服务。设备被撤销后旧凭证无法连接，须管理员生成新配对码并用新配置目录重新注册。

Linux 用户服务：复制 `deploy/aremote-host.service` 到 `~/.config/systemd/user/aremote-host.service`，修改 WorkingDirectory 与 Node 路径为实际位置。注册必须使用相同用户和 AREMOTE_HOME。

```bash
systemctl --user daemon-reload
systemctl --user enable --now aremote-host
systemctl --user status aremote-host
```

如需退出登录后运行，按服务器管理方式为该用户启用 linger。不要以 root 身份运行日常 Agent，Host 使用运行它的操作系统用户权限。

## Client 与授权

Web 访问 Server `/login`；安装包输入 Server HTTPS 地址后加载同一原 workspace UI。输入设备名称、配对码或注册密码，完成首次注册；管理后台把该 Client 授权给对应 Host。刷新列表，选在线 Host，进入原终端/Agent/文件界面。

ARemote 静态客户端统一通过 Server 中继连接。若从 Host 本机的 `http://127.0.0.1:2208` 打开该客户端，登录页仍需填写实际 Server 地址；Host 本地地址不提供 Server 的设备注册 API。推荐直接访问 Server 提供的页面。

密码注册不等于授予访问权。Server 管理页可以撤销设备、移除 ACL、查看在线状态、最近连接时间、会话和字节计数。轮换客户端凭证在登录/Host 列表页操作。客户端凭证存浏览器/WebView 的私有 origin 存储，不传入 URL；WS URL 仅携带 30 秒内有效的一次性票据。Caddy 默认不启用访问日志，若自行启用须删除 query 参数，避免记录票据。

跨源部署 Web Client 时在 `ALLOWED_ORIGINS` 中显式列出来源（逗号分隔）；使用同 Server 提供的 Web UI 或安装壳默认无需跨源。不要用通配符允许任意网页读取设备 API。

Compose 的 Server 仅在内部网络可达，并设置 `TRUST_PROXY=1`；Caddy 会覆盖 `X-Forwarded-For` 为直接客户端地址，登录和注册分别按真实客户端地址限流。Node 独立部署默认忽略转发头；只有后端入口受可信反向代理隔离、代理覆盖该头时才启用 `TRUST_PROXY=1`，不要在可直接访问的公网 Node 端口上启用。

断网/Server 重启会销毁当前中继会话，Host 自动重连，Client 重试并重新加入原会话。终端由原 PTY daemon 保留；离线键盘输入不会排队重放。超过客户端重试窗口后可在原重连界面手动重试。撤销是认证错误，应重新授权/注册而不是反复尝试旧凭证。

## 开发与验证

```bash
npm test --prefix server --workspaces=false
node --test host/aremote/test/integration.test.js
node scripts/buildWebStatic.mjs
ADMIN_PASSWORD='本地测试至少12字符密码' WEB_DIR=./web/out node server/index.js
```

Node 原生 HTTP 仅用于 loopback 开发或受控 TLS 反向代理后面；公网使用上面的 HTTPS Compose 部署。
