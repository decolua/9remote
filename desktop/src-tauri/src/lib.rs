use tauri::{
    AppHandle, Emitter, Manager,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
use std::io::BufRead;
use std::sync::{Arc, Mutex};

// Global sidecar PID to kill on exit
static SIDECAR_PID: std::sync::OnceLock<Arc<Mutex<Option<u32>>>> = std::sync::OnceLock::new();

fn get_sidecar_pid() -> &'static Arc<Mutex<Option<u32>>> {
    SIDECAR_PID.get_or_init(|| Arc::new(Mutex::new(None)))
}

fn kill_sidecar() {
    if let Ok(mut pid_lock) = get_sidecar_pid().lock() {
        if let Some(pid) = pid_lock.take() {
            eprintln!("Killing sidecar PID: {pid}");
            #[cfg(unix)]
            { let _ = std::process::Command::new("kill").args(["-TERM", &pid.to_string()]).spawn(); }
            #[cfg(windows)]
            { let _ = std::process::Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).spawn(); }
        }
    }
}

#[derive(Clone, serde::Serialize)]
struct SidecarEvent {
    payload: String,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct PermissionStatus {
    screen_recording: bool,
    accessibility: bool,
}

// Check macOS permissions via CGWindowListCopyWindowInfo (screen) and AXIsProcessTrusted (accessibility)
#[tauri::command]
fn check_permissions() -> PermissionStatus {
    #[cfg(target_os = "macos")]
    {
        let screen_recording = check_screen_recording();
        let accessibility = check_accessibility();
        PermissionStatus { screen_recording, accessibility }
    }
    #[cfg(not(target_os = "macos"))]
    {
        PermissionStatus { screen_recording: true, accessibility: true }
    }
}

#[cfg(target_os = "macos")]
fn check_screen_recording() -> bool {
    use std::process::Command;
    // CGWindowListCopyWindowInfo returns redacted names when screen recording is denied
    // We check by running a tiny Swift snippet via `swift -`
    let script = "import CoreGraphics\nlet list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []\nlet hasName = list.contains { ($0[\"kCGWindowOwnerName\"] as? String) != nil }\nprint(hasName ? \"1\" : \"0\")";
    let output = Command::new("swift").arg("-").stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).spawn()
        .and_then(|mut child| {
            use std::io::Write;
            if let Some(stdin) = child.stdin.as_mut() {
                let _ = stdin.write_all(script.as_bytes());
            }
            child.wait_with_output()
        });
    match output {
        Ok(o) => String::from_utf8_lossy(&o.stdout).trim() == "1",
        Err(_) => false,
    }
}

#[cfg(target_os = "macos")]
fn check_accessibility() -> bool {
    use std::process::Command;
    // AXIsProcessTrusted returns true only when Accessibility permission granted
    let script = "import ApplicationServices\nprint(AXIsProcessTrusted() ? \"1\" : \"0\")";
    let output = Command::new("swift").arg("-").stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).spawn()
        .and_then(|mut child| {
            use std::io::Write;
            if let Some(stdin) = child.stdin.as_mut() {
                let _ = stdin.write_all(script.as_bytes());
            }
            child.wait_with_output()
        });
    match output {
        Ok(o) => String::from_utf8_lossy(&o.stdout).trim() == "1",
        Err(_) => false,
    }
}

// Request permission — triggers native OS dialog, then opens System Preferences as fallback
#[tauri::command]
fn request_permission(permission_type: String) {
    #[cfg(target_os = "macos")]
    {
        match permission_type.as_str() {
            "screenRecording" => {
                // CGRequestScreenCaptureAccess() triggers native permission dialog
                // and registers app in System Preferences list
                let script = "import CoreGraphics\nCGRequestScreenCaptureAccess()";
                let _ = std::process::Command::new("swift")
                    .arg("-")
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .and_then(|mut child| {
                        use std::io::Write;
                        if let Some(stdin) = child.stdin.as_mut() {
                            let _ = stdin.write_all(script.as_bytes());
                        }
                        child.wait_with_output()
                    });
                // Also open System Preferences so user can toggle
                let _ = std::process::Command::new("open")
                    .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
                    .spawn();
            }
            "accessibility" => {
                // AXIsProcessTrustedWithOptions triggers Accessibility dialog
                let script = "import ApplicationServices\nlet opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary\nAXIsProcessTrustedWithOptions(opts)";
                let _ = std::process::Command::new("swift")
                    .arg("-")
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .and_then(|mut child| {
                        use std::io::Write;
                        if let Some(stdin) = child.stdin.as_mut() {
                            let _ = stdin.write_all(script.as_bytes());
                        }
                        child.wait_with_output()
                    });
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
fn copy_to_clipboard(app: AppHandle, text: String) {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let _ = app.clipboard().write_text(text);
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

// Find node binary across common install locations
fn find_node_binary() -> String {
    let candidates = [
        "/usr/local/bin/node",
        "/usr/bin/node",
        "/opt/homebrew/bin/node",
    ];
    // Check fixed paths first
    for path in &candidates {
        if std::path::Path::new(path).exists() {
            return path.to_string();
        }
    }
    // Check nvm default location
    if let Ok(home) = std::env::var("HOME") {
        let nvm_default = format!("{home}/.nvm/alias/default");
        if let Ok(version) = std::fs::read_to_string(&nvm_default) {
            let version = version.trim();
            let nvm_node = format!("{home}/.nvm/versions/node/{version}/bin/node");
            if std::path::Path::new(&nvm_node).exists() {
                return nvm_node;
            }
        }
        // Glob nvm versions — pick latest
        let nvm_dir = format!("{home}/.nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
            let mut versions: Vec<_> = entries.flatten()
                .map(|e| e.path())
                .collect();
            versions.sort();
            if let Some(latest) = versions.last() {
                let node = latest.join("bin/node");
                if node.exists() {
                    return node.to_string_lossy().to_string();
                }
            }
        }
    }
    "node".to_string() // fallback
}

// Dev mode: spawn node directly via std::process (bypasses Tauri shell PATH restrictions)
fn spawn_node_sidecar(app: AppHandle, node_bin: String, sidecar_path: String) {
    tauri::async_runtime::spawn_blocking(move || {
        use std::process::{Command, Stdio};
        let mut child = match Command::new(&node_bin)
            .arg(&sidecar_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => { eprintln!("Failed to spawn node: {e}"); return; }
        };

        // Store PID for cleanup on exit
        if let Ok(mut pid_lock) = get_sidecar_pid().lock() {
            *pid_lock = Some(child.id());
        }

        let stdout = match child.stdout.take() {
            Some(s) => s,
            None => { eprintln!("No stdout from sidecar"); return; }
        };

        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            let _ = app.emit("sidecar_event", SidecarEvent { payload: line });
        }

        let _ = child.wait();
    });
}

// Spawn Node.js sidecar and pipe events to frontend
fn spawn_sidecar(app: AppHandle) {
    let app_clone = app.clone();

    // Resolve sidecar/index.js relative to binary location
    // Binary: desktop/src-tauri/target/debug/nine-remote-desktop
    // Sidecar: desktop/sidecar/index.js  (3 levels up from binary)
    let sidecar_path = std::env::current_exe().ok()
        .and_then(|exe| exe.parent().map(|p| p.join("../../../sidecar/index.js")))
        .and_then(|p| p.canonicalize().ok())
        .filter(|p| p.exists());

    tauri::async_runtime::spawn(async move {
        let shell = app_clone.shell();

        // Try bundled sidecar binary — if spawn fails, fallback to node dev mode
        let tauri_spawn = shell.sidecar("sidecar").and_then(|cmd| cmd.spawn());

        match tauri_spawn {
            Ok((mut rx, _child)) => {
                eprintln!("Sidecar binary spawned via Tauri");
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            let line_str = String::from_utf8_lossy(&line).to_string();
                            let _ = app_clone.emit("sidecar_event", SidecarEvent { payload: line_str });
                        }
                        CommandEvent::Stderr(line) => {
                            let msg = String::from_utf8_lossy(&line).to_string();
                            let payload = format!(
                                "{{\"type\":\"log\",\"level\":\"error\",\"msg\":{}}}",
                                serde_json::to_string(&msg).unwrap_or_default()
                            );
                            let _ = app_clone.emit("sidecar_event", SidecarEvent { payload });
                        }
                        _ => {}
                    }
                }
            }
            Err(_) => {
                // Dev fallback: spawn node directly via std::process
                match sidecar_path {
                    Some(path) => {
                        let node_bin = find_node_binary();
                        eprintln!("Dev mode: {} {}", node_bin, path.display());
                        spawn_node_sidecar(app_clone, node_bin, path.to_string_lossy().to_string());
                    }
                    None => eprintln!("Could not find sidecar/index.js"),
                }
            }
        }
    });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            // System tray
            let show = MenuItem::with_id(app, "show", "Show/Hide Window", true, Some("CmdOrCtrl+H"))?;
            let copy_url = MenuItem::with_id(app, "copy_url", "Copy URL", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit 9Remote", true, Some("CmdOrCtrl+Q"))?;
            let menu = Menu::with_items(app, &[&show, &copy_url, &quit])?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                    "copy_url" => {
                        let _ = app.emit("tray_copy_url", ());
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // Spawn sidecar
            spawn_sidecar(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            check_permissions,
            request_permission,
            copy_to_clipboard,
            quit_app,
        ])
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                kill_sidecar();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
