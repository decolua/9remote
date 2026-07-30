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
const NPM_INSTALL_TIMEOUT_SECS: u64 = 300;
const NODE_DOWNLOAD_URL: &str = "https://nodejs.org/en/download";

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

// Parse "v22.22.0" / "22.22" into comparable numeric tuple
fn parse_version(name: &str) -> (u32, u32, u32) {
    let mut parts = name.trim_start_matches('v').split('.');
    let mut next = || parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    (next(), next(), next())
}

// Highest-versioned node under a version-manager dir, optionally filtered by prefix
fn newest_node_in(dir: &str, prefix: Option<&str>) -> Option<String> {
    let mut best: Option<((u32, u32, u32), String)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(p) = prefix {
            let stripped = name.trim_start_matches('v');
            if stripped != p && !stripped.starts_with(&format!("{p}.")) { continue; }
        }
        let node = entry.path().join("bin/node");
        if !node.exists() { continue; }
        let version = parse_version(&name);
        if best.as_ref().is_none_or(|(b, _)| version > *b) {
            best = Some((version, node.to_string_lossy().to_string()));
        }
    }
    best.map(|(_, path)| path)
}

fn find_node_binary() -> String {
    let home = home_dir();
    let cached = format!("{home}/{NODE_CACHE_DIR}/bin/node");
    if std::path::Path::new(&cached).exists() {
        return cached;
    }

    // nvm: resolve alias ("22") to the highest matching install ("v22.22.0")
    let nvm_dir = format!("{home}/.nvm/versions/node");
    if let Ok(alias) = std::fs::read_to_string(format!("{home}/.nvm/alias/default")) {
        let alias = alias.trim();
        let exact = format!("{nvm_dir}/{alias}/bin/node");
        if std::path::Path::new(&exact).exists() { return exact; }
        if let Some(node) = newest_node_in(&nvm_dir, Some(alias.trim_start_matches('v'))) {
            return node;
        }
    }
    if let Some(node) = newest_node_in(&nvm_dir, None) { return node; }

    // Other version managers
    for dir in [format!("{home}/.local/share/fnm/node-versions"), format!("{home}/Library/Application Support/fnm/node-versions")] {
        if let Some(node) = newest_node_in(&dir, None) { return node; }
    }
    let volta = format!("{home}/.volta/bin/node");
    if std::path::Path::new(&volta).exists() { return volta; }

    let candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
    for path in &candidates {
        if std::path::Path::new(path).exists() { return path.to_string(); }
    }
    // Homebrew versioned formulae (node@22, node@20, ...)
    for cellar in ["/opt/homebrew/opt", "/usr/local/opt"] {
        if let Ok(entries) = std::fs::read_dir(cellar) {
            let mut best: Option<((u32, u32, u32), String)> = None;
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let Some(ver) = name.strip_prefix("node@") else { continue };
                let node = entry.path().join("bin/node");
                if !node.exists() { continue; }
                let version = parse_version(ver);
                if best.as_ref().is_none_or(|(b, _)| version > *b) {
                    best = Some((version, node.to_string_lossy().to_string()));
                }
            }
            if let Some((_, path)) = best { return path; }
        }
    }
    "node".to_string()
}

// True when no real Node was found (bare name only resolvable via PATH, which GUI apps lack)
fn node_missing() -> bool {
    find_node_binary() == "node"
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

// Streams npm output so the UI shows live progress; kills the run past the timeout.
// `progress` None = silent (background update).
fn run_npm_install(target: &str, progress: Option<&AppHandle>) -> bool {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    let prefix = npm_prefix();
    if let Err(e) = std::fs::create_dir_all(&prefix) {
        eprintln!("[Desktop] mkdir prefix failed: {e}");
        if let Some(app) = progress {
            let _ = app.emit("setup_error", format!("Cannot create {prefix}: {e}"));
        }
        return false;
    }

    if node_missing() {
        eprintln!("[Desktop] Node.js not found on this system");
        if let Some(app) = progress {
            let _ = app.emit("setup_error", format!("Node.js not found. Install it from {NODE_DOWNLOAD_URL}, then reopen 9Remote."));
        }
        return false;
    }

    let npm = find_npm_binary();
    let mut child = match Command::new(&npm)
        .args(["install", "--prefix", &prefix, "--no-audit", "--no-fund", "--loglevel", "http", target])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[Desktop] npm spawn failed ({npm}): {e}");
            if let Some(app) = progress {
                let _ = app.emit("setup_error", format!("Cannot run npm ({npm}): {e}"));
            }
            return false;
        }
    };

    if let Some(app) = progress {
        let _ = app.emit("setup_progress", format!("Downloading {target}..."));
    }

    // npm writes progress to stderr; count fetched packages for a live counter
    if let Some(err) = child.stderr.take() {
        let app = progress.cloned();
        std::thread::spawn(move || {
            let mut fetched = 0usize;
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                eprintln!("[npm] {line}");
                if !line.contains("http fetch") { continue; }
                fetched += 1;
                if fetched % 10 != 0 { continue; }
                if let Some(app) = &app {
                    let _ = app.emit("setup_progress", format!("Downloading packages... ({fetched})"));
                }
            }
        });
    }
    if let Some(out) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                eprintln!("[npm] {line}");
            }
        });
    }

    // Watchdog: kill the install if it exceeds the timeout
    let done = Arc::new(AtomicBool::new(false));
    let killer = done.clone();
    let pid = child.id();
    std::thread::spawn(move || {
        for _ in 0..NPM_INSTALL_TIMEOUT_SECS {
            std::thread::sleep(std::time::Duration::from_secs(1));
            if killer.load(Ordering::Relaxed) { return; }
        }
        eprintln!("[Desktop] npm install timed out after {NPM_INSTALL_TIMEOUT_SECS}s, killing {pid}");
        let _ = std::process::Command::new("kill").arg("-9").arg(pid.to_string()).status();
    });

    let status = child.wait();
    done.store(true, Ordering::Relaxed);

    match status {
        Ok(s) if s.success() => true,
        Ok(s) => {
            eprintln!("[Desktop] npm install {target} failed: {s}");
            if let Some(app) = progress {
                let _ = app.emit("setup_error", "Install failed. Check that you are online, then reopen 9Remote.");
            }
            false
        }
        Err(e) => {
            eprintln!("[Desktop] npm wait failed: {e}");
            if let Some(app) = progress {
                let _ = app.emit("setup_error", format!("Install failed: {e}"));
            }
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
    if run_npm_install(NPM_PACKAGE, Some(app)) {
        eprintln!("[Desktop] Install OK");
        let _ = app.emit("setup_progress", "Install complete, starting...");
        is_9remote_installed()
    } else {
        false
    }
}

// Silent background update; runs after agent is up so user is never blocked
fn spawn_background_update(app: AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        eprintln!("[Desktop] Checking for updates in background...");
        let target = format!("{NPM_PACKAGE}@latest");
        if run_npm_install(&target, None) {
            eprintln!("[Desktop] Background update complete (applies on next launch)");
            let _ = app.emit("update_ready", ());
        } else {
            eprintln!("[Desktop] Background update failed — staying on current version");
            let _ = app.emit("update_failed", ());
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
