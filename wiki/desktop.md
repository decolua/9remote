# Desktop (Tauri)

Wrap UI Next.js. Spawn agent (`npm exec 9remote ui`). Tray + permissions.

## Architecture

```
Tauri Window (420×680, non-resizable)
  └─ src/index.html (splash)
       listen "setup_ready" → location = http://localhost:2208

Subprocess: npm exec -- 9remote ui (port 2208)
  ↑ Tauri poll /api/health 1s × 30 → emit setup_ready
```

## IPC commands

```rust
#[tauri::command] check_permissions() -> { screen_recording, accessibility }
#[tauri::command] request_permission(permission_type: String)
#[tauri::command] quit_app(app)  // app.exit(0)
```

| Command | macOS | Windows |
|---|---|---|
| check_permissions | Swift `CGWindowListCopyWindowInfo` + `AXIsProcessTrusted` | always true |
| request_permission "screen" | Swift `CGRequestScreenCaptureAccess` + open `x-apple.systempreferences:Privacy_ScreenCapture` | `cmd /c start ms-settings:privacy-screencapture` |
| request_permission "accessibility" | `AXIsProcessTrustedWithOptions` + open `Privacy_Accessibility` | n/a |

```js
import { invoke } from "@tauri-apps/api"
await invoke("check_permissions")
await invoke("request_permission", { permissionType: "screen" })
```

## Tray

| Item | Shortcut | Action |
|---|---|---|
| Show/Hide Window | `CmdOrCtrl+H` | toggle visibility + focus |
| Copy URL | — | emit `tray_copy_url` |
| Quit 9Remote | `CmdOrCtrl+Q` | `app.exit(0)` |

Left-click icon → show + focus. `show_menu_on_left_click=false`.

## Subprocess spawn

```rust
NPM_PACKAGE = "9remote"
SERVER_PORT = 2208

ensure_9remote_installed:
  npm list -g --depth=0 9remote
  if missing → npm install -g 9remote

spawn:
  npm exec -- 9remote ui
  stdout/stderr → background threads → eprintln!

health poll:
  GET http://localhost:2208/api/health  (1s × 30)
  emit "setup_progress" {status} → emit "setup_ready" khi 200
```

### Node binary discovery (theo thứ tự)

1. `~/.9remote/node/bin/node`
2. `/usr/local/bin/node`
3. `/usr/bin/node`
4. `/opt/homebrew/bin/node`
5. `~/.nvm/alias/default`
6. Newest version trong `~/.nvm/versions/node/*`
7. `node` từ `$PATH`

`find_npm_binary`: `npm` cùng folder node, fallback `npm` PATH.

## Splash flow

```
NINEREMOTE_ENV=development:
  win.eval("location='http://localhost:5173'")  // skip subprocess
else:
  ensure_9remote_installed → spawn_9remote_ui → poll health
  emit setup_progress: "Installing..." | "Starting server..."
  emit setup_ready khi 200 → splash redirect localhost:2208
```

## Platform branches

- **macOS**: `run_swift(script)` spawn `swift -` đọc stdin (CoreGraphics + AX APIs).
- **Windows**: `cmd /c start ms-settings:...`, kill `taskkill /F /PID`.
- **Unix**: kill `kill -TERM`.

## PID tracking

```rust
static NODE_PID: OnceLock<Arc<Mutex<Option<u32>>>>
// set sau spawn = child.id()
// WindowEvent::Destroyed → kill_node_process()
```

Không lưu PID file.

## Files

```
desktop/
  src/                    splash UI (HTML/JS)
  src-tauri/
    src/lib.rs            ~420 LOC: IPC + tray + spawn + permissions
    tauri.conf.json       window/tray config, allowed IPC
    Cargo.toml
  package.json            scripts dev/build/install
```

## Mở rộng

- **IPC mới**: `#[tauri::command] fn name() -> ...` + register vào `invoke_handler!`.
- **Tray item mới**: edit `tray_menu` builder.
- **Permission khác**: thêm match arm trong `request_permission` + script.
- **Auto-update**: chưa có. Self-update qua `npm install -g 9remote` (CLI check `/api/version`).
