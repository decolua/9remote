use tauri::{
    AppHandle, Emitter, Manager,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};

const SERVER_PORT: u16 = 2208;
const VITE_PORT: u16 = 5173;
const NPM_PREFIX_DIR: &str = ".9remote/npm";
const NODE_CACHE_DIR: &str = ".9remote/node";
const NPM_PACKAGE: &str = "9remote";
const CLI_REL_PATH: &str = "node_modules/9remote/dist/cli.cjs";
const HEALTH_TIMEOUT_SECS: u64 = 60;

// Track full PID chain for clean shutdown
static AGENT_PID: std::sync::OnceLock<std::sync::Arc<std::sync::Mutex<Option<u32>>>> =
    std::sync::OnceLock::new();

fn get_agent_pid() -> &'static std::sync::Arc<std::sync::Mutex<Option<u32>>> {
    AGENT_PID.get_or_init(|| std::sync::Arc::new(std::sync::Mutex::new(None)))
}

// Kill agent process group so server.cjs + cloudflared children don't leak
fn kill_agent_tree() {
    let pid = match get_agent_pid().lock() {
        Ok(mut g) => g.take(),
        Err(_) => None,
    };
    let Some(pid) = pid else { return };
    eprintln!("[Desktop] Killing agent tree PID: {pid}");
    #[cfg(unix)]
    {
        // Negative pid = kill entire process group
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .status();
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .status();
    }
}

// ── Permission structs ──────────────────────────────────────────────────────

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct PermissionStatus {
    screen_recording: bool,
    accessibility: bool,
}

#[tauri::command]
fn check_permissions() -> PermissionStatus {
    #[cfg(target_os = "macos")]
    {
        PermissionStatus {
            screen_recording: check_screen_recording(),
            accessibility: check_accessibility(),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        PermissionStatus { screen_recording: true, accessibility: true }
    }
}

#[cfg(target_os = "macos")]
fn check_screen_recording() -> bool {
    let script = "import CoreGraphics\nlet list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []\nlet hasName = list.contains { ($0[\"kCGWindowOwnerName\"] as? String) != nil }\nprint(hasName ? \"1\" : \"0\")";
    run_swift(script).trim() == "1"
}

#[cfg(target_os = "macos")]
fn check_accessibility() -> bool {
    let script = "import ApplicationServices\nprint(AXIsProcessTrusted() ? \"1\" : \"0\")";
    run_swift(script).trim() == "1"
}

#[cfg(target_os = "macos")]
fn run_swift(script: &str) -> String {
    use std::io::Write;
    let result = std::process::Command::new("swift")
        .arg("-")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .and_then(|mut child| {
            if let Some(stdin) = child.stdin.as_mut() {
                let _ = stdin.write_all(script.as_bytes());
            }
            child.wait_with_output()
        });
    match result {
        Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
        Err(_) => String::new(),
    }
}

#[tauri::command]
fn request_permission(permission_type: String) {
    #[cfg(target_os = "macos")]
    {
        match permission_type.as_str() {
            "screenRecording" => {
                let script = "import CoreGraphics\nCGRequestScreenCaptureAccess()";
                let _ = run_swift(script);
                let _ = std::process::Command::new("open")
                    .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
                    .spawn();
            }
            "accessibility" => {
                let script = "import ApplicationServices\nlet opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary\nAXIsProcessTrustedWithOptions(opts)";
                let _ = run_swift(script);
                let _ = std::process::Command::new("open")
                    .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
                    .spawn();
            }
            _ => {}
        }
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/c", "start", "ms-settings:privacy-screencapture"])
            .spawn();
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

// macOS dock badge / Windows taskbar overlay. count <= 0 clears it.
// Platforms without badge support (most Linux DEs) return an error → JS ignores.
#[tauri::command]
fn set_badge(app: AppHandle, count: i64) -> Result<(), String> {
    let value = if count > 0 { Some(count) } else { None };
    match app.get_webview_window("main") {
        Some(win) => win.set_badge_count(value).map_err(|e| e.to_string()),
        None => Err("main window not found".into()),
    }
}

// Local OS notification banner. Rust-side so JS doesn't need plugin ACL.
#[tauri::command]
fn show_notif(app: AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

// ── Path helpers ────────────────────────────────────────────────────────────

fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| std::env::var("USERPROFILE").unwrap_or_default())
}

fn npm_prefix() -> String {
    format!("{}/{}", home_dir(), NPM_PREFIX_DIR)
}

fn cli_path() -> String {
    format!("{}/{}", npm_prefix(), CLI_REL_PATH)
}

fn find_node_binary() -> String {
    let home = home_dir();
    let cached = format!("{home}/{NODE_CACHE_DIR}/bin/node");
    if std::path::Path::new(&cached).exists() {
        return cached;
    }
    let candidates = ["/usr/local/bin/node", "/usr/bin/node", "/opt/homebrew/bin/node"];
    for path in &candidates {
        if std::path::Path::new(path).exists() { return path.to_string(); }
    }
    let nvm_default = format!("{home}/.nvm/alias/default");
    if let Ok(version) = std::fs::read_to_string(&nvm_default) {
        let nvm_node = format!("{home}/.nvm/versions/node/{}/bin/node", version.trim());
        if std::path::Path::new(&nvm_node).exists() { return nvm_node; }
    }
    let nvm_dir = format!("{home}/.nvm/versions/node");
    if let Ok(mut entries) = std::fs::read_dir(&nvm_dir) {
        let mut versions: Vec<_> = entries.by_ref().flatten().map(|e| e.path()).collect();
        versions.sort();
        if let Some(latest) = versions.last() {
            let node = latest.join("bin/node");
            if node.exists() { return node.to_string_lossy().to_string(); }
        }
    }
    "node".to_string()
}

fn find_npm_binary() -> String {
    let node = find_node_binary();
    if let Some(bin_dir) = std::path::Path::new(&node).parent() {
        let npm = bin_dir.join("npm");
        if npm.exists() { return npm.to_string_lossy().to_string(); }
    }
    "npm".to_string()
}

// ── Install + spawn ─────────────────────────────────────────────────────────

fn is_9remote_installed() -> bool {
    std::path::Path::new(&cli_path()).exists()
}

fn run_npm_install(target: &str) -> bool {
    let prefix = npm_prefix();
    if let Err(e) = std::fs::create_dir_all(&prefix) {
        eprintln!("[Desktop] mkdir prefix failed: {e}");
        return false;
    }
    let npm = find_npm_binary();
    match std::process::Command::new(&npm)
        .args(["install", "--prefix", &prefix, "--no-audit", "--no-fund", target])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
    {
        Ok(o) if o.status.success() => true,
        Ok(o) => {
            eprintln!("[Desktop] npm install {target} failed:");
            eprintln!("stdout: {}", String::from_utf8_lossy(&o.stdout));
            eprintln!("stderr: {}", String::from_utf8_lossy(&o.stderr));
            false
        }
        Err(e) => {
            eprintln!("[Desktop] npm spawn failed: {e}");
            false
        }
    }
}

fn ensure_9remote_installed(app: &AppHandle) -> bool {
    if is_9remote_installed() {
        eprintln!("[Desktop] Found cli.cjs at {}", cli_path());
        return true;
    }
    eprintln!("[Desktop] Installing {NPM_PACKAGE} to {} ...", npm_prefix());
    let _ = app.emit("setup_progress", "Installing 9Remote (first time)...");
    if run_npm_install(NPM_PACKAGE) {
        eprintln!("[Desktop] Install OK");
        is_9remote_installed()
    } else {
        let _ = app.emit("setup_progress", "Installation failed - check logs");
        false
    }
}

// Silent background update; runs after agent is up so user is never blocked
fn spawn_background_update(app: AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        eprintln!("[Desktop] Checking for updates in background...");
        let target = format!("{NPM_PACKAGE}@latest");
        if run_npm_install(&target) {
            eprintln!("[Desktop] Background update complete (applies on next launch)");
            let _ = app.emit("update_ready", ());
        }
    });
}

// Spawn agent directly via node (skip npm exec overhead) + new process group
fn spawn_9remote_ui(app: AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        use std::process::{Command, Stdio};
        use std::io::{BufRead, BufReader};

        let node = find_node_binary();
        let cli = cli_path();
        eprintln!("[Desktop] Spawning: {node} {cli} ui");
        let _ = app.emit("setup_progress", "Starting 9Remote server...");

        let mut cmd = Command::new(&node);
        cmd.arg(&cli).arg("ui")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // New process group so SIGTERM to -pid kills entire tree on shutdown
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            unsafe { cmd.pre_exec(|| { libc::setsid(); Ok(()) }); }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NEW_PROCESS_GROUP = 0x00000200
            cmd.creation_flags(0x00000200);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[Desktop] Failed to spawn agent: {e}");
                let _ = app.emit("setup_progress", format!("Error spawning: {e}"));
                return;
            }
        };

        if let Ok(mut g) = get_agent_pid().lock() { *g = Some(child.id()); }

        if let Some(stdout) = child.stdout.take() {
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().flatten() {
                    eprintln!("[9remote] {line}");
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().flatten() {
                    eprintln!("[9remote.err] {line}");
                }
            });
        }

        // Poll health until ready
        let url = format!("http://localhost:{SERVER_PORT}/api/health");
        for i in 0..HEALTH_TIMEOUT_SECS {
            std::thread::sleep(std::time::Duration::from_secs(1));
            if let Ok(resp) = ureq::get(&url).call() {
                if resp.status() == 200 {
                    eprintln!("[Desktop] Server ready after {}s", i + 1);
                    let _ = app.emit("setup_ready", ());
                    break;
                }
            }
            if i + 1 == HEALTH_TIMEOUT_SECS {
                eprintln!("[Desktop] Server timeout {HEALTH_TIMEOUT_SECS}s");
                let _ = app.emit("setup_progress", "Server timeout - check Console.app logs");
            }
        }

        let _ = child.wait();
    });
}

// ── Main run ───────────────────────────────────────────────────────────────

pub fn run() {
    let is_dev = std::env::var("NINEREMOTE_ENV")
        .map(|v| v == "development")
        .unwrap_or(false);

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            // ── System tray ──
            let show = MenuItem::with_id(app, "show", "Show/Hide Window", true, Some("CmdOrCtrl+H"))?;
            let check_update = MenuItem::with_id(app, "check_update", "Check for Updates", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit 9Remote", true, Some("CmdOrCtrl+Q"))?;
            let menu = Menu::with_items(app, &[&show, &check_update, &quit])?;

            // Embedded agent tray PNG (terminal glyph) — same icon as CLI tray
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/trayIcon.png"))?;
            TrayIconBuilder::new()
                .icon(tray_icon)
                .icon_as_template(false)
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_tray_icon_event(|_tray, _event| { /* menu opens on left click */ })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) { let _ = win.hide(); }
                            else { let _ = win.show(); let _ = win.set_focus(); }
                        }
                    }
                    "check_update" => { spawn_background_update(app.clone()); }
                    "quit" => { kill_agent_tree(); app.exit(0); }
                    _ => {}
                })
                .build(app)?;

            // ── Dev: load Vite directly ──
            if is_dev {
                if let Some(win) = app.get_webview_window("main") {
                    let url = format!("http://localhost:{VITE_PORT}");
                    let _ = win.eval(&format!("window.location.href = '{url}'"));
                }
            } else {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if ensure_9remote_installed(&app_handle) {
                        spawn_9remote_ui(app_handle.clone());
                        // Silent background update — applies on next launch
                        spawn_background_update(app_handle);
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            check_permissions,
            request_permission,
            quit_app,
            set_badge,
            show_notif,
        ])
        .on_window_event(|window, event| {
            // Close button → hide window (keep agent alive in tray)
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
