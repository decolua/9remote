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
// Local install (`npm install --prefix`, no -g) lands in <prefix>/node_modules on every OS
const CLI_REL_PATH: &str = "node_modules/9remote/dist/cli.cjs";
const HEALTH_TIMEOUT_SECS: u64 = 60;
const HEALTH_POLL_MS: u64 = 200;
const NPM_INSTALL_TIMEOUT_SECS: u64 = 300;
const NODE_DOWNLOAD_URL: &str = "https://nodejs.org/en/download";
// N-API 10 lands in v22.14 — @julusian/jpeg-turbo@3 is built against it and segfaults
// (not a catchable throw) on anything older, so an older Node counts as no Node at all.
const MIN_NODE: (u32, u32) = (22, 14);
// Pinned: the app must never swap the runtime under a running agent. Node 24 is the
// active LTS, so one download lasts until 2028.
const NODE_LTS_VERSION: &str = "v24.19.0";
const NODE_DIST_BASE: &str = "https://nodejs.org/dist";
const NODE_DOWNLOAD_TIMEOUT_SECS: u64 = 600;
// Keep spawned children from allocating a console window in this GUI-subsystem app
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
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
fn request_permission(#[allow(unused_variables)] permission_type: String) {
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
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("cmd")
            .args(["/c", "start", "ms-settings:privacy-screencapture"])
            .creation_flags(CREATE_NO_WINDOW)
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

// Opens http(s) links in the user's default browser. The agent UI calls this for
// target="_blank" / window.open — Tauri's webview swallows those without it.
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| format!("Invalid URL: {url}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("Refused non-http(s) URL: {url}"));
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}

// ── Path helpers ────────────────────────────────────────────────────────────

fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| std::env::var("USERPROFILE").unwrap_or_default())
}

fn npm_prefix() -> String {
    format!("{}/{}", home_dir(), NPM_PREFIX_DIR)
}

// Global `npm i -g 9remote` install, if the user already has one.
// Reusing it avoids a redundant 270-package install into our private prefix.
fn global_cli_path() -> Option<String> {
    // Volta is omitted: its package images nest under an extra <version> segment,
    // so there is no fixed path to probe. Those users fall back to the private prefix.
    #[cfg(windows)]
    let mut roots = {
        let env = |k: &str| std::env::var(k).unwrap_or_default();
        vec![
            format!("{}\\npm\\node_modules", env("APPDATA")),
            format!("{}\\nodejs\\node_modules", env("ProgramFiles")),
        ]
    };
    // Windows npm puts globals next to node itself: <dir>\node.exe → <dir>\node_modules
    #[cfg(windows)]
    {
        let node = find_node_binary();
        if let Some(dir) = std::path::Path::new(&node).parent() {
            roots.insert(0, dir.join("node_modules").to_string_lossy().to_string());
        }
    }

    #[cfg(not(windows))]
    let mut roots = vec![
        "/usr/local/lib/node_modules".to_string(),
        "/opt/homebrew/lib/node_modules".to_string(),
        format!("{}/.volta/tools/image/packages/{NPM_PACKAGE}/lib/node_modules", home_dir()),
    ];
    // Version-manager installs live next to the node binary: <prefix>/bin/node → <prefix>/lib/node_modules
    #[cfg(not(windows))]
    {
        let node = find_node_binary();
        if let Some(prefix) = std::path::Path::new(&node).parent().and_then(|p| p.parent()) {
            roots.insert(0, prefix.join("lib/node_modules").to_string_lossy().to_string());
        }
    }
    roots.into_iter().find_map(|root| {
        let cli = format!("{root}/{NPM_PACKAGE}/dist/cli.cjs");
        std::path::Path::new(&cli).exists().then_some(cli)
    })
}

// Private prefix wins when present (we control its version); otherwise reuse a global install.
fn cli_path() -> String {
    let private = format!("{}/{}", npm_prefix(), CLI_REL_PATH);
    if std::path::Path::new(&private).exists() { return private; }
    global_cli_path().unwrap_or(private)
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
        // nvm-windows puts node.exe at the version root; fnm nests it under installation/
        #[cfg(windows)]
        let rels = ["node.exe", "installation/node.exe"];
        #[cfg(not(windows))]
        let rels = ["bin/node"];
        let Some(node) = rels.iter().map(|r| entry.path().join(r)).find(|p| p.exists()) else { continue };
        let version = parse_version(&name);
        if best.as_ref().is_none_or(|(b, _)| version > *b) {
            best = Some((version, node.to_string_lossy().to_string()));
        }
    }
    best.map(|(_, path)| path)
}

#[cfg(windows)]
fn find_system_node() -> String {
    let env = |k: &str| std::env::var(k).unwrap_or_default();

    // nvm-windows keeps the active version symlinked here — respect the user's `nvm use`
    let symlink = env("NVM_SYMLINK");
    if !symlink.is_empty() {
        let node = format!("{symlink}\\node.exe");
        if std::path::Path::new(&node).exists() { return node; }
    }

    // nvm-windows root: <NVM_HOME>\vX.Y.Z\node.exe
    let nvm_home = env("NVM_HOME");
    if !nvm_home.is_empty() {
        if let Some(node) = newest_node_in(&nvm_home, None) { return node; }
    }

    // fnm: <FNM_DIR|%APPDATA%\fnm|%LOCALAPPDATA%\fnm>\node-versions\vX.Y.Z\installation\node.exe
    let fnm_dir = env("FNM_DIR");
    let fnm_roots = if fnm_dir.is_empty() {
        vec![format!("{}\\fnm", env("APPDATA")), format!("{}\\fnm", env("LOCALAPPDATA"))]
    } else {
        vec![fnm_dir]
    };
    for root in fnm_roots {
        if let Some(node) = newest_node_in(&format!("{root}\\node-versions"), None) { return node; }
    }

    // Volta: resolve the real node, not %VOLTA_HOME%\bin\node.exe — that is a shim with
    // no npm beside it. Windows images have node.exe at the image root (no bin/ subdir).
    let volta_home = match env("VOLTA_HOME") {
        v if !v.is_empty() => v,
        _ => format!("{}\\Volta", env("LOCALAPPDATA")),
    };
    if let Some(node) = newest_node_in(&format!("{volta_home}\\tools\\image\\node"), None) {
        return node;
    }

    for base in [env("ProgramFiles"), env("ProgramFiles(x86)"), env("LOCALAPPDATA")] {
        if base.is_empty() { continue; }
        let node = format!("{base}\\nodejs\\node.exe");
        if std::path::Path::new(&node).exists() { return node; }
    }

    // Last resort: walk PATH ourselves. Shelling out to `where` would flash a console
    // window on every call, and this runs on several code paths.
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let node = dir.join("node.exe");
            if node.exists() { return node.to_string_lossy().to_string(); }
        }
    }
    "node".to_string()
}

#[cfg(not(windows))]
fn find_system_node() -> String {
    let home = home_dir();

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

// Our downloaded runtime: <cache>/bin/node on unix, <cache>\node.exe on Windows
fn cached_node_path() -> String {
    let home = home_dir();
    if cfg!(windows) {
        format!("{home}/{NODE_CACHE_DIR}/node.exe")
    } else {
        format!("{home}/{NODE_CACHE_DIR}/bin/node")
    }
}

// Runs `node -v` and parses "v24.19.0" into (24, 19). None when it won't execute —
// which also catches a glibc binary unpacked onto a musl system.
fn node_version(path: &str) -> Option<(u32, u32)> {
    let mut cmd = std::process::Command::new(path);
    cmd.arg("-v");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() { return None; }
    let text = String::from_utf8_lossy(&out.stdout);
    let (major, minor, _) = parse_version(text.trim());
    (major > 0).then_some((major, minor))
}

fn node_is_supported(path: &str) -> bool {
    node_version(path).is_some_and(|v| v >= MIN_NODE)
}

// Our own runtime wins — we know its version. A system Node is only used when it is
// new enough; too old is treated as absent so ensure_node() downloads a good one.
fn find_node_binary() -> String {
    let cached = cached_node_path();
    if std::path::Path::new(&cached).exists() && node_is_supported(&cached) {
        return cached;
    }
    let system = find_system_node();
    if system != "node" && node_is_supported(&system) {
        return system;
    }
    "node".to_string()
}

// True when no usable Node was found — either none at all, or all of them too old
fn node_missing() -> bool {
    find_node_binary() == "node"
}

// ── Node runtime download ───────────────────────────────────────────────────

// The <os>-<arch> slug nodejs.org publishes, or None where it ships no build:
// linux armv7 (dropped in Node 24) and musl (official builds are glibc-only).
fn node_platform_slug() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("windows", "x86_64") => Some("win-x64"),
        ("windows", "aarch64") => Some("win-arm64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        _ => None,
    }
}

fn node_archive_ext() -> &'static str {
    if cfg!(windows) { "zip" } else { "tar.gz" }
}

// SHA256 of the archive, read from the release's SHASUMS256.txt
fn fetch_expected_sha(file_name: &str) -> Option<String> {
    let url = format!("{NODE_DIST_BASE}/{NODE_LTS_VERSION}/SHASUMS256.txt");
    let body = ureq::get(&url).call().ok()?.into_string().ok()?;
    body.lines().find_map(|line| {
        let (sha, name) = line.split_once("  ")?;
        (name.trim() == file_name).then(|| sha.to_string())
    })
}

fn download_with_progress(url: &str, app: &AppHandle) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let resp = ureq::get(url)
        .timeout(std::time::Duration::from_secs(NODE_DOWNLOAD_TIMEOUT_SECS))
        .call()
        .map_err(|e| format!("download failed: {e}"))?;

    let total: usize = resp
        .header("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let mut reader = resp.into_reader();
    let mut buf = Vec::with_capacity(total.max(1 << 22));
    let mut chunk = vec![0u8; 1 << 16];
    let mut last_mb = 0;
    loop {
        let n = reader.read(&mut chunk).map_err(|e| format!("read failed: {e}"))?;
        if n == 0 { break; }
        buf.extend_from_slice(&chunk[..n]);
        // Emit per megabyte, not per chunk — 64KB chunks would flood the UI
        let mb = buf.len() >> 20;
        if mb > last_mb {
            last_mb = mb;
            let msg = if total > 0 {
                format!("Downloading Node.js... {} / {} MB", mb, total >> 20)
            } else {
                format!("Downloading Node.js... {mb} MB")
            };
            let _ = app.emit("setup_progress", msg);
        }
    }
    Ok(buf)
}

fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

// Archives wrap everything in a `node-v24.19.0-<slug>/` directory; strip it so the
// layout matches what cached_node_path() expects. Rejects any path that still
// escapes after stripping — defense-in-depth even though the archive is checksummed.
fn strip_root(path: &std::path::Path) -> Option<std::path::PathBuf> {
    use std::path::Component;
    let mut parts = path.components();
    parts.next()?; // drop the top-level versioned dir
    let rest: std::path::PathBuf = parts.collect();
    if rest.as_os_str().is_empty() { return None; }
    // No parent-dir components, no absolute paths — keep extraction inside dest
    rest.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir)).then_some(rest)
}

#[cfg(not(windows))]
fn extract_archive(data: &[u8], dest: &std::path::Path) -> Result<(), String> {
    let decoder = flate2::read::GzDecoder::new(data);
    let mut archive = tar::Archive::new(decoder);
    archive.set_preserve_permissions(true);
    for entry in archive.entries().map_err(|e| format!("tar read failed: {e}"))? {
        let mut entry = entry.map_err(|e| format!("tar entry failed: {e}"))?;
        let path = entry.path().map_err(|e| format!("tar path failed: {e}"))?.into_owned();
        let Some(rel) = strip_root(&path) else { continue };
        entry
            .unpack(dest.join(rel))
            .map_err(|e| format!("unpack failed: {e}"))?;
    }
    Ok(())
}

#[cfg(windows)]
fn extract_archive(data: &[u8], dest: &std::path::Path) -> Result<(), String> {
    use std::io::{Cursor, Write};
    let mut archive =
        zip::ZipArchive::new(Cursor::new(data)).map_err(|e| format!("zip open failed: {e}"))?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| format!("zip entry failed: {e}"))?;
        let Some(path) = file.enclosed_name() else { continue };
        let Some(rel) = strip_root(&path) else { continue };
        let out = dest.join(rel);
        if file.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| format!("mkdir failed: {e}"))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
        }
        let mut dst = std::fs::File::create(&out).map_err(|e| format!("create failed: {e}"))?;
        std::io::copy(&mut file, &mut dst).map_err(|e| format!("write failed: {e}"))?;
        dst.flush().ok();
    }
    Ok(())
}

fn download_node(app: &AppHandle) -> Result<(), String> {
    let Some(slug) = node_platform_slug() else {
        return Err(format!(
            "No official Node.js build for {}-{}. Install Node {}.{}+ manually from {NODE_DOWNLOAD_URL}.",
            std::env::consts::OS, std::env::consts::ARCH, MIN_NODE.0, MIN_NODE.1
        ));
    };

    // Official builds are glibc-only. On musl (Alpine) the download would extract fine but
    // fail to execute — catch it now and point at the package manager instead.
    #[cfg(target_os = "linux")]
    if std::fs::symlink_metadata("/lib/ld-musl-x86_64.so.1").is_ok()
        || std::fs::symlink_metadata("/lib/ld-musl-aarch64.so.1").is_ok()
    {
        return Err(
            "This is a musl-based Linux (e.g. Alpine). Install Node with `apk add nodejs npm` instead.".into(),
        );
    }

    let file_name = format!("node-{NODE_LTS_VERSION}-{slug}.{}", node_archive_ext());
    let url = format!("{NODE_DIST_BASE}/{NODE_LTS_VERSION}/{file_name}");
    eprintln!("[Desktop] Downloading Node from {url}");
    let _ = app.emit("setup_progress", "Downloading Node.js...");

    let data = download_with_progress(&url, app)?;

    // A corrupt or tampered archive must never reach extraction
    match fetch_expected_sha(&file_name) {
        Some(expected) => {
            let actual = sha256_hex(&data);
            if actual != expected {
                return Err("Node.js download failed checksum verification".into());
            }
        }
        None => return Err("Could not verify the Node.js download (checksum unavailable)".into()),
    }

    let _ = app.emit("setup_progress", "Extracting Node.js...");
    let dest = format!("{}/{NODE_CACHE_DIR}", home_dir());
    let dest = std::path::Path::new(&dest);
    // Start clean so a half-extracted previous attempt can't shadow this one
    let _ = std::fs::remove_dir_all(dest);
    std::fs::create_dir_all(dest).map_err(|e| format!("Cannot create {}: {e}", dest.display()))?;

    if let Err(e) = extract_archive(&data, dest) {
        let _ = std::fs::remove_dir_all(dest);
        return Err(e);
    }

    // Prove it runs here rather than failing later inside npm
    let node = cached_node_path();
    match node_version(&node) {
        Some(v) if v >= MIN_NODE => {
            eprintln!("[Desktop] Node {}.{} ready at {node}", v.0, v.1);
            Ok(())
        }
        _ => {
            let _ = std::fs::remove_dir_all(dest);
            Err("The downloaded Node.js does not run on this system".into())
        }
    }
}

// Guarantees a usable Node before anything tries to run npm or the agent.
fn ensure_node(app: &AppHandle) -> bool {
    if !node_missing() {
        let node = find_node_binary();
        let v = node_version(&node).unwrap_or((0, 0));
        eprintln!("[Desktop] Using Node {}.{} at {node}", v.0, v.1);
        return true;
    }
    eprintln!("[Desktop] No Node >= {}.{} found — downloading", MIN_NODE.0, MIN_NODE.1);
    match download_node(app) {
        Ok(()) => true,
        Err(e) => {
            eprintln!("[Desktop] Node download failed: {e}");
            let _ = app.emit("setup_error", e);
            false
        }
    }
}

// npm's JS entrypoint, run via node. Avoids npm.cmd: CreateProcessW cannot execute
// batch files directly, and Rust's verbatim paths break cmd.exe (rust-lang/rust#95178).
fn find_npm_cli() -> Option<String> {
    let node = find_node_binary();
    let dir = std::path::Path::new(&node).parent()?;
    // Windows keeps npm beside node.exe; POSIX puts it in <prefix>/lib/node_modules
    let roots = [dir.to_path_buf(), dir.parent()?.join("lib")];
    roots
        .iter()
        .map(|r| r.join("node_modules/npm/bin/npm-cli.js"))
        .find(|p| p.exists())
        .map(|p| p.to_string_lossy().to_string())
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

    // ensure_node() runs first in the startup path; this only guards the background
    // update, which has no AppHandle to download through.
    if node_missing() {
        eprintln!("[Desktop] No usable Node.js — skipping npm run");
        if let Some(app) = progress {
            let _ = app.emit("setup_error", format!("Node.js not found. Install it from {NODE_DOWNLOAD_URL}, then reopen 9Remote."));
        }
        return false;
    }

    let node = find_node_binary();
    let Some(npm_cli) = find_npm_cli() else {
        eprintln!("[Desktop] npm not found next to node ({node})");
        if let Some(app) = progress {
            let _ = app.emit("setup_error", format!("npm not found. Reinstall Node.js from {NODE_DOWNLOAD_URL}."));
        }
        return false;
    };
    let mut npm = Command::new(&node);
    npm.args([&npm_cli, "install", "--prefix", &prefix, "--no-audit", "--no-fund", "--loglevel", "http", target])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        npm.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = match npm.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[Desktop] npm spawn failed ({npm_cli}): {e}");
            if let Some(app) = progress {
                let _ = app.emit("setup_error", format!("Cannot run npm: {e}"));
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
        let path = cli_path();
        let source = if global_cli_path().as_deref() == Some(path.as_str()) { "global" } else { "private" };
        eprintln!("[Desktop] Found cli.cjs ({source}) at {path}");
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
        // A global install updates itself (agent's own updateChecker) — don't shadow it with a private copy
        if global_cli_path().is_some_and(|g| g == cli_path()) {
            eprintln!("[Desktop] Using global install — skipping private update");
            return;
        }
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
        cmd.arg(&cli).arg("ui").arg("--start") // --start: open the tunnel without waiting for a click
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null()); // GUI apps have no usable stdin — don't let the agent inherit it

        // The agent respawns its server as bare `node`, resolved via PATH. A Finder-launched
        // GUI only inherits /usr/bin:/bin:/usr/sbin:/sbin, so nvm/fnm/volta installs are invisible
        // and the child dies with ENOENT. Put our resolved node dir first.
        if let Some(dir) = std::path::Path::new(&node).parent() {
            let existing = std::env::var("PATH").unwrap_or_default();
            let sep = if cfg!(windows) { ";" } else { ":" };
            cmd.env("PATH", format!("{}{sep}{existing}", dir.display()));
        }

        // New process group so SIGTERM to -pid kills entire tree on shutdown
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            unsafe { cmd.pre_exec(|| { libc::setsid(); Ok(()) }); }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW — a GUI app has no console,
            // so the child would otherwise allocate a visible one.
            cmd.creation_flags(0x00000200 | CREATE_NO_WINDOW);
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

        // Poll health until ready — sub-second interval so a fast boot isn't rounded up to 1s
        let _ = app.emit("setup_progress", "Starting server...");
        let url = format!("http://localhost:{SERVER_PORT}/api/health");
        let attempts = HEALTH_TIMEOUT_SECS * 1000 / HEALTH_POLL_MS;
        let almost_ready_at = 15 * 1000 / HEALTH_POLL_MS;
        for i in 0..attempts {
            if i == almost_ready_at { let _ = app.emit("setup_progress", "Almost ready..."); }
            if let Ok(resp) = ureq::get(&url).call() {
                if resp.status() == 200 {
                    eprintln!("[Desktop] Server ready after {}ms", (i + 1) * HEALTH_POLL_MS);
                    let _ = app.emit("setup_ready", ());
                    // Navigate from Rust: the splash cannot fetch/redirect itself
                    // (tauri://localhost → http://localhost is cross-origin, blocked by WKWebView)
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.eval(&format!("window.location.href = 'http://localhost:{SERVER_PORT}'"));
                    }
                    // Update only once the agent is serving — never overwrite files it is reading
                    spawn_background_update(app.clone());
                    break;
                }
            }
            if i + 1 == attempts {
                eprintln!("[Desktop] Server timeout {HEALTH_TIMEOUT_SECS}s");
                let _ = app.emit("setup_error", "Server did not start in time. Check Console.app for [9remote] logs.");
            }
            std::thread::sleep(std::time::Duration::from_millis(HEALTH_POLL_MS));
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
        .plugin(tauri_plugin_opener::init())
        .on_page_load(|webview, payload| {
            // The agent UI opens login/docs links via window.open + target="_blank", which
            // Tauri's webview swallows. Reroute them to the OS browser. Only act inside the
            // Tauri shell — the same UI served standalone in a regular browser is untouched.
            if payload.event() != tauri::webview::PageLoadEvent::Finished { return; }
            // http://localhost = agent UI; tauri://localhost = splash, skip it
            let url = payload.url();
            if url.scheme() != "http" || url.host_str() != Some("localhost") { return; }
            // window.open() is not covered by opener's click handler, so route it
            // manually. target="_blank" links are handled by the opener plugin itself.
            let js = r#"
                (function(){
                    if (window.__9r_external_patched) return;
                    window.__9r_external_patched = true;
                    var invoke = window.__TAURI_INTERNALS__.invoke;
                    var openExt = function(url){ if(url) invoke('open_external', { url: String(url) }); };
                    window.open = function(url){
                        if (url) { openExt(url); return null; }
                        // Agent uses window.open("") then .location.href = X to dodge popup
                        // blockers — proxy the href setter so the URL still reaches the browser.
                        var loc = {};
                        Object.defineProperty(loc, 'href', {
                            set: function(v){ openExt(String(v)); },
                            get: function(){ return ''; }
                        });
                        return { location: loc, close: function(){}, focus: function(){} };
                    };
                })();
            "#;
            let _ = webview.eval(js);
        })
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
                    // spawn_9remote_ui navigates the webview and kicks the update once healthy
                    if ensure_node(&app_handle) && ensure_9remote_installed(&app_handle) {
                        spawn_9remote_ui(app_handle);
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
            open_external,
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
