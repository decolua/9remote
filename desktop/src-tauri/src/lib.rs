use tauri::{
    AppHandle, Emitter, Manager,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

const SERVER_PORT: u16 = 2208;
const VITE_PORT: u16 = 5173;
const NODE_CACHE_DIR: &str = ".9remote/node";
const NPM_PACKAGE: &str = "9remote";

// Global Node process PID for cleanup on exit
static NODE_PID: std::sync::OnceLock<std::sync::Arc<std::sync::Mutex<Option<u32>>>> =
    std::sync::OnceLock::new();

fn get_node_pid() -> &'static std::sync::Arc<std::sync::Mutex<Option<u32>>> {
    NODE_PID.get_or_init(|| std::sync::Arc::new(std::sync::Mutex::new(None)))
}

fn kill_node_process() {
    if let Ok(mut pid_lock) = get_node_pid().lock() {
        if let Some(pid) = pid_lock.take() {
            eprintln!("Killing node process PID: {pid}");
            #[cfg(unix)]
            { let _ = std::process::Command::new("kill").args(["-TERM", &pid.to_string()]).spawn(); }
            #[cfg(windows)]
            { let _ = std::process::Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).spawn(); }
        }
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

// ── Node binary helpers ─────────────────────────────────────────────────────

/// Returns path to cached node binary (~/.9remote/node/bin/node)
/// or falls back to system node
fn find_node_binary() -> String {
    // Check cached node first
    if let Ok(home) = std::env::var("HOME") {
        let cached = format!("{home}/{NODE_CACHE_DIR}/bin/node");
        if std::path::Path::new(&cached).exists() {
            eprintln!("[Desktop] Using cached node: {}", cached);
            return cached;
        }
    }
    // System node paths
    let candidates = [
        "/usr/local/bin/node",
        "/usr/bin/node",
        "/opt/homebrew/bin/node",
    ];
    for path in &candidates {
        if std::path::Path::new(path).exists() {
            eprintln!("[Desktop] Using system node: {}", path);
            return path.to_string();
        }
    }
    // nvm
    if let Ok(home) = std::env::var("HOME") {
        let nvm_default = format!("{home}/.nvm/alias/default");
        if let Ok(version) = std::fs::read_to_string(&nvm_default) {
            let nvm_node = format!("{home}/.nvm/versions/node/{}/bin/node", version.trim());
            if std::path::Path::new(&nvm_node).exists() {
                eprintln!("[Desktop] Using nvm default node: {}", nvm_node);
                return nvm_node;
            }
        }
        let nvm_dir = format!("{home}/.nvm/versions/node");
        if let Ok(mut entries) = std::fs::read_dir(&nvm_dir) {
            let mut versions: Vec<_> = entries.by_ref().flatten().map(|e| e.path()).collect();
            versions.sort();
            if let Some(latest) = versions.last() {
                let node = latest.join("bin/node");
                if node.exists() {
                    let node_path = node.to_string_lossy().to_string();
                    eprintln!("[Desktop] Using nvm latest node: {}", node_path);
                    return node_path;
                }
            }
        }
    }
    eprintln!("[Desktop] Falling back to 'node' in PATH");
    "node".to_string()
}

/// Find npm binary alongside node
fn find_npm_binary() -> String {
    let node = find_node_binary();
    let node_path = std::path::Path::new(&node);
    if let Some(bin_dir) = node_path.parent() {
        let npm = bin_dir.join("npm");
        if npm.exists() {
            return npm.to_string_lossy().to_string();
        }
    }
    "npm".to_string()
}

// ── Spawn 9remote ui ───────────────────────────────────────────────────────

/// Production: spawn `npm exec -- 9remote ui` then poll health
fn spawn_9remote_ui(app: AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        use std::process::{Command, Stdio};
        use std::io::{BufRead, BufReader};

        let npm = find_npm_binary();
        
        eprintln!("[Desktop] Spawning: {} exec -- {} ui", npm, NPM_PACKAGE);
        let _ = app.emit("setup_progress", "Starting 9Remote server...");

        let mut child = match Command::new(&npm)
            .args(["exec", "--", NPM_PACKAGE, "ui"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[Desktop] Failed to spawn 9remote ui: {e}");
                let _ = app.emit("setup_progress", format!("Error spawning: {e}"));
                return;
            }
        };

        if let Ok(mut pid_lock) = get_node_pid().lock() {
            *pid_lock = Some(child.id());
        }

        // Capture stdout/stderr in background threads
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        
        if let Some(stdout) = stdout {
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines().flatten() {
                    eprintln!("[9remote stdout] {}", line);
                }
            });
        }
        
        if let Some(stderr) = stderr {
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().flatten() {
                    eprintln!("[9remote stderr] {}", line);
                }
            });
        }

        // Poll health until server ready (max 30s)
        let health_url = format!("http://localhost:{SERVER_PORT}/api/health");
        let mut attempts = 0;
        for i in 0..30 {
            std::thread::sleep(std::time::Duration::from_secs(1));
            attempts = i + 1;
            
            match ureq::get(&health_url).call() {
                Ok(resp) => {
                    if resp.status() == 200 {
                        eprintln!("[Desktop] Server ready after {} seconds", attempts);
                        let _ = app.emit("setup_ready", ());
                        break;
                    }
                }
                Err(e) => {
                    if i % 5 == 0 {
                        eprintln!("[Desktop] Health check attempt {}/30: {}", attempts, e);
                    }
                }
            }
        }
        
        if attempts >= 30 {
            eprintln!("[Desktop] Server failed to start after 30s");
            let _ = app.emit("setup_progress", "Server timeout - check Console.app logs");
        }

        let _ = child.wait();
    });
}

/// Check if 9remote is already installed globally
fn is_9remote_installed() -> bool {
    let npm = find_npm_binary();
    eprintln!("[Desktop] Checking if {} is installed via: {}", NPM_PACKAGE, npm);
    let output = std::process::Command::new(&npm)
        .args(["list", "-g", "--depth=0", NPM_PACKAGE])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output();
    match output {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let installed = stdout.contains(NPM_PACKAGE);
            eprintln!("[Desktop] {} installed: {}", NPM_PACKAGE, installed);
            installed
        }
        Err(e) => {
            eprintln!("[Desktop] Failed to check installation: {}", e);
            false
        }
    }
}

/// Install 9remote globally if not present
fn ensure_9remote_installed(app: &AppHandle) {
    if is_9remote_installed() {
        eprintln!("[Desktop] 9Remote already installed");
        let _ = app.emit("setup_progress", "Starting 9Remote...");
        return;
    }
    
    eprintln!("[Desktop] Installing 9Remote globally (first time)...");
    let _ = app.emit("setup_progress", "Installing 9Remote (first time setup)...");
    
    let npm = find_npm_binary();
    eprintln!("[Desktop] Using npm: {}", npm);
    
    match std::process::Command::new(&npm)
        .args(["install", "-g", NPM_PACKAGE])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
    {
        Ok(output) => {
            if !output.status.success() {
                eprintln!("[Desktop] npm install failed:");
                eprintln!("stdout: {}", String::from_utf8_lossy(&output.stdout));
                eprintln!("stderr: {}", String::from_utf8_lossy(&output.stderr));
                let _ = app.emit("setup_progress", "Installation failed - check logs");
                return;
            }
            eprintln!("[Desktop] 9Remote installed successfully");
        }
        Err(e) => {
            eprintln!("[Desktop] Failed to run npm install: {}", e);
            let _ = app.emit("setup_progress", format!("Install error: {}", e));
            return;
        }
    }
    
    let _ = app.emit("setup_progress", "Starting server...");
}

// ── Main run ───────────────────────────────────────────────────────────────

pub fn run() {
    let is_dev = std::env::var("NINEREMOTE_ENV")
        .map(|v| v == "development")
        .unwrap_or(false);

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(move |app| {
            // ── System tray ──
            let show = MenuItem::with_id(app, "show", "Show/Hide Window", true, Some("CmdOrCtrl+H"))?;
            let copy_url = MenuItem::with_id(app, "copy_url", "Copy URL", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit 9Remote", true, Some("CmdOrCtrl+Q"))?;
            let menu = Menu::with_items(app, &[&show, &copy_url, &quit])?;

            TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                    "copy_url" => { let _ = app.emit("tray_copy_url", ()); }
                    "quit" => { app.exit(0); }
                    _ => {}
                })
                .build(app)?;

            // ── Dev: load Vite directly ──
            if is_dev {
                if let Some(win) = app.get_webview_window("main") {
                    let url = format!("http://localhost:{VITE_PORT}");
                    let _ = win.eval(&format!("window.location.href = '{url}'"));
                }
            }
            // Production: splash screen handles redirect after setup_ready event

            // ── Spawn 9remote (production only) ──
            if !is_dev {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    ensure_9remote_installed(&app_handle);
                    spawn_9remote_ui(app_handle);
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            check_permissions,
            request_permission,
            quit_app,
        ])
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                kill_node_process();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
