mod usage;

use chrono::Local;
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;

const TRAY_ID: &str = "main";
const WINDOW_LABEL: &str = "dashboard";
const DUMP_INTERVAL: Duration = Duration::from_secs(30 * 60);

static RESOURCE_ROOT: OnceLock<PathBuf> = OnceLock::new();

struct AppState {
    last_error: Mutex<Option<String>>,
    dump_busy: Mutex<()>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DashboardState {
    snapshot: Option<Value>,
    config: Value,
    home: String,
    extension_path: String,
    last_error: Option<String>,
    missing_snapshot: bool,
    chatgpt_extension_ready: bool,
    cursor_device_ready: bool,
    app_version: String,
    default_hostname: String,
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn ai_usage_home() -> PathBuf {
    std::env::var("AI_USAGE_HOME")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".ai-usage"))
}

fn snapshot_path(home: &Path) -> PathBuf {
    home.join("snapshot.json")
}

fn config_path(home: &Path) -> PathBuf {
    home.join("config.json")
}

fn load_json(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, serde_json::to_string_pretty(value).map_err(|e| e.to_string())? + "\n")
        .map_err(|e| e.to_string())
}

fn load_config(home: &Path) -> Value {
    load_json(&config_path(home)).unwrap_or_else(|| json!({}))
}

fn normalize_hostname(raw: &str) -> String {
    let trimmed = raw.trim();
    trimmed
        .strip_suffix(".local")
        .unwrap_or(trimmed)
        .to_string()
}

fn machine_hostname() -> String {
    Command::new("hostname")
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| normalize_hostname(&value))
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
}

fn ensure_config(home: &Path) -> Value {
    let _ = fs::create_dir_all(home);
    let mut cfg = load_config(home);
    let mut dirty = false;
    if cfg.get("includeChatgptInTotal").and_then(Value::as_bool).is_none() {
        cfg["includeChatgptInTotal"] = json!(true);
        dirty = true;
    }
    if cfg.get("theme").and_then(Value::as_str).is_none() {
        cfg["theme"] = json!("system");
        dirty = true;
    }
    if cfg.get("currency").and_then(Value::as_str).is_none() {
        cfg["currency"] = json!("USD");
        dirty = true;
    }
    if cfg.get("includeCacheInTotal").and_then(Value::as_bool).is_none() {
        cfg["includeCacheInTotal"] = json!(false);
        dirty = true;
    }
    let hostname_empty = cfg
        .get("hostname")
        .and_then(Value::as_str)
        .map(|value| value.trim().is_empty())
        .unwrap_or(true);
    if hostname_empty {
        let host = machine_hostname();
        if !host.is_empty() {
            cfg["hostname"] = json!(host);
            dirty = true;
        }
    }
    if dirty {
        let _ = write_json(&config_path(home), &cfg);
    }
    cfg
}

fn include_chatgpt(config: &Value) -> bool {
    config
        .get("includeChatgptInTotal")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn include_cache_in_total(config: &Value) -> bool {
    config
        .get("includeCacheInTotal")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn jsonl_has_record(path: &Path) -> bool {
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };
    text.lines().any(|line| {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return false;
        }
        serde_json::from_str::<Value>(trimmed)
            .ok()
            .map(|value| value.is_object())
            .unwrap_or(false)
    })
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var(name)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

fn resolve_resource_root(app: Option<&AppHandle>) -> PathBuf {
    if let Some(p) = env_path("AI_USAGE_ROOT") {
        return p;
    }
    if cfg!(debug_assertions) {
        return PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    }
    if let Some(app) = app {
        if let Ok(dir) = app.path().resource_dir() {
            return dir;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn init_resource_root(app: &AppHandle) {
    let _ = RESOURCE_ROOT.set(resolve_resource_root(Some(app)));
}

fn resource_root() -> PathBuf {
    RESOURCE_ROOT
        .get()
        .cloned()
        .unwrap_or_else(|| resolve_resource_root(None))
}

fn dump_script_from(root: &Path) -> PathBuf {
    root.join("sidecar/dump.mjs")
}

fn extension_path_from(root: &Path) -> PathBuf {
    root.join("extension")
}

fn hook_installer_from(root: &Path) -> PathBuf {
    root.join("sidecar/install-cursor-hook.mjs")
}

fn native_host_installer_from(root: &Path) -> PathBuf {
    root.join("sidecar/install-native-host.mjs")
}

fn extension_path() -> PathBuf {
    extension_path_from(&resource_root())
}

fn dump_script() -> PathBuf {
    if let Some(p) = env_path("AI_USAGE_DUMP") {
        return p;
    }
    dump_script_from(&resource_root())
}

fn find_node() -> PathBuf {
    if let Some(p) = env_path("AI_USAGE_NODE") {
        return p;
    }
    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("/usr/bin/node"),
    ];
    if let Ok(pf) = std::env::var("ProgramFiles") {
        candidates.push(PathBuf::from(pf).join("nodejs/node.exe"));
    }
    if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
        candidates.push(PathBuf::from(pf86).join("nodejs/node.exe"));
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join("Programs/nodejs/node.exe"));
    }
    for candidate in candidates {
        if candidate.exists() {
            return candidate;
        }
    }
    PathBuf::from("node")
}

fn unix_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    format!("/opt/homebrew/bin:/usr/local/bin:{current}")
}

fn try_with_dump_lock<R>(lock: &Mutex<()>, f: impl FnOnce() -> R) -> Option<R> {
    let _guard = lock.try_lock().ok()?;
    Some(f())
}

fn run_dump() -> Result<(), String> {
    let home = ai_usage_home();
    fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let script = dump_script();
    if !script.exists() {
        return Err(format!("找不到 sidecar：{}", script.display()));
    }
    let mut cmd = Command::new(find_node());
    cmd.arg(&script)
        .env("AI_USAGE_HOME", &home)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(unix)]
    {
        cmd.env("PATH", unix_path());
    }
    let output = cmd
        .output()
        .map_err(|e| format!("无法启动 node：{e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let msg = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            format!("sidecar 退出码 {:?}", output.status.code())
        };
        Err(msg)
    }
}

fn run_dump_exclusive(app: &AppHandle) -> Result<bool, String> {
    let Some(state) = app.try_state::<AppState>() else {
        run_dump()?;
        return Ok(true);
    };
    match try_with_dump_lock(&state.dump_busy, run_dump) {
        None => Ok(false),
        Some(Ok(())) => Ok(true),
        Some(Err(err)) => Err(err),
    }
}

fn dashboard_payload(app: &AppHandle) -> DashboardState {
    let home = ai_usage_home();
    let config = ensure_config(&home);
    let snap = snapshot_path(&home);
    let snapshot = load_json(&snap);
    let missing_snapshot = snapshot.is_none();
    let last_error = app
        .try_state::<AppState>()
        .and_then(|state| state.last_error.lock().ok().and_then(|g| g.clone()));
    let extension = extension_path()
        .canonicalize()
        .unwrap_or_else(|_| extension_path());
    DashboardState {
        snapshot,
        config,
        home: home.display().to_string(),
        extension_path: extension.display().to_string(),
        last_error,
        missing_snapshot,
        chatgpt_extension_ready: jsonl_has_record(&home.join("chatgpt-web.jsonl")),
        cursor_device_ready: jsonl_has_record(&home.join("cursor-device.jsonl")),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        default_hostname: machine_hostname(),
    }
}

fn update_tray_title(app: &AppHandle) {
    let home = ai_usage_home();
    let config = ensure_config(&home);
    let include = include_chatgpt(&config);
    let cache_in_total = include_cache_in_total(&config);
    let label = match load_json(&snapshot_path(&home)) {
        Some(Value::Object(map)) => {
            let buckets = map.get("buckets").and_then(Value::as_array);
            usage::tray_label(
                buckets.map(|v| v.as_slice()).unwrap_or(&[]),
                include,
                cache_in_total,
                Local::now(),
            )
        }
        _ => "—".to_string(),
    };
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_title(Some(&label));
        let _ = tray.set_tooltip(Some(format!("AI Usage  {label}")));
    }
}

fn set_error(app: &AppHandle, error: Option<String>) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut slot) = state.last_error.lock() {
            *slot = error;
        }
    }
}

fn refresh_and_notify(app: &AppHandle) {
    match run_dump_exclusive(app) {
        Ok(false) => return,
        Ok(true) => set_error(app, None),
        Err(err) => set_error(app, Some(err)),
    }
    update_tray_title(app);
    let _ = app.emit("snapshot-updated", ());
}

fn spawn_dump(app: AppHandle) {
    thread::spawn(move || {
        refresh_and_notify(&app);
    });
}

#[cfg(target_os = "macos")]
fn set_activation_policy(app: &AppHandle, policy: tauri::ActivationPolicy) {
    let _ = app.set_activation_policy(policy);
}

fn sync_autostart(app: &AppHandle) {
    let home = ai_usage_home();
    let mut cfg = ensure_config(&home);
    if cfg.get("autostart").is_none() {
        let _ = app.autolaunch().enable();
        cfg["autostart"] = json!(true);
        let _ = write_json(&config_path(&home), &cfg);
        return;
    }
    let wanted = cfg.get("autostart").and_then(Value::as_bool).unwrap_or(false);
    match app.autolaunch().is_enabled() {
        Ok(false) if wanted => {
            let _ = app.autolaunch().enable();
        }
        Ok(true) if !wanted => {
            let _ = app.autolaunch().disable();
        }
        _ => {}
    }
}

fn theme_from_config(config: &Value) -> Option<tauri::Theme> {
    match config.get("theme").and_then(Value::as_str) {
        Some("light") => Some(tauri::Theme::Light),
        Some("dark") => Some(tauri::Theme::Dark),
        _ => None,
    }
}

fn apply_window_theme(app: &AppHandle) {
    let theme = theme_from_config(&ensure_config(&ai_usage_home()));
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.set_theme(theme);
    }
}

fn hide_dashboard_to_tray(window: &tauri::Window) {
    let _ = window.hide();
    let _ = window.set_skip_taskbar(true);
    #[cfg(target_os = "macos")]
    set_activation_policy(window.app_handle(), tauri::ActivationPolicy::Accessory);
}

fn open_dashboard(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    set_activation_policy(app, tauri::ActivationPolicy::Regular);

    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        apply_window_theme(app);
        let _ = window.set_skip_taskbar(false);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let theme = theme_from_config(&ensure_config(&ai_usage_home()));
    let builder = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App("index.html".into()))
        .title("AI Usage")
        .inner_size(1120.0, 800.0)
        .min_inner_size(860.0, 600.0)
        .resizable(true)
        .skip_taskbar(false)
        .visible(true)
        .theme(theme);
    if let Ok(window) = builder.build() {
        let _ = window.set_focus();
    }
}

fn quit_app(app: &AppHandle) {
    app.exit(0);
}

fn hook_installer() -> PathBuf {
    hook_installer_from(&resource_root())
}

fn native_host_installer() -> PathBuf {
    native_host_installer_from(&resource_root())
}

fn run_node_script(script: PathBuf) -> Result<String, String> {
    if !script.exists() {
        return Err(format!("找不到脚本：{}", script.display()));
    }
    let node = find_node();
    let mut cmd = Command::new(&node);
    cmd.arg(&script)
        .env("AI_USAGE_HOME", ai_usage_home())
        .env("AI_USAGE_NODE", &node)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(unix)]
    {
        cmd.env("PATH", unix_path());
    }
    let output = cmd
        .output()
        .map_err(|e| format!("无法启动 node：{e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        Err(if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            format!("{} 失败", script.display())
        })
    }
}

fn bootstrap_collectors() {
    let _ = run_node_script(hook_installer());
    let _ = run_node_script(native_host_installer());
}

fn is_http_url(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.starts_with("https://") || trimmed.starts_with("http://")
}

fn github_update_error(status: u16) -> String {
    match status {
        403 => "GitHub 暂时拒绝了检查请求，请稍后重试".to_string(),
        404 => "还没有发布版本".to_string(),
        0 => "无法检查更新".to_string(),
        code => format!("检查失败（{code}）"),
    }
}

fn split_curl_status(stdout: &str) -> (&str, u16) {
    const MARKER: &str = "\nHTTPSTATUS:";
    if let Some(idx) = stdout.rfind(MARKER) {
        let status = stdout[idx + MARKER.len()..].trim().parse().unwrap_or(0);
        return (&stdout[..idx], status);
    }
    (stdout, 0)
}

fn open_target(target: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut cmd = Command::new("open");
    #[cfg(target_os = "windows")]
    let mut cmd = Command::new(if is_http_url(target) { "cmd" } else { "explorer" });
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut cmd = Command::new("xdg-open");
    #[cfg(target_os = "macos")]
    if is_http_url(target) {
        cmd.arg("-u");
    }
    #[cfg(target_os = "windows")]
    if is_http_url(target) {
        cmd.args(["/C", "start", "", target]);
    } else {
        cmd.arg(target);
    }
    #[cfg(not(target_os = "windows"))]
    cmd.arg(target);
    cmd.status()
        .map_err(|e| format!("无法打开 {target}：{e}"))
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err(format!("打开 {target} 失败"))
            }
        })
}

fn open_in_file_manager(path: &str) -> Result<(), String> {
    open_target(path.trim())
}

const GITHUB_LATEST_RELEASE: &str =
    "https://api.github.com/repos/HaofeiMa/ai-usage/releases/latest";
const GITHUB_RELEASES_ATOM: &str = "https://github.com/HaofeiMa/ai-usage/releases.atom";

fn between<'a>(haystack: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let from = haystack.find(start)? + start.len();
    let rest = haystack.get(from..)?;
    let to = rest.find(end)?;
    rest.get(..to)
}

fn decode_basic_html(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("<p>", "")
        .replace("</p>", "\n")
        .replace("<br>", "\n")
        .replace("<br/>", "\n")
        .replace("<br />", "\n")
}

fn strip_tags(value: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in value.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.trim().to_string()
}

fn parse_releases_atom(xml: &str) -> Option<Value> {
    let entry = xml.split_once("<entry>")?.1;
    let url = entry
        .split("href=\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .unwrap_or("")
        .to_string();
    if !url.contains("/releases/tag/") {
        return None;
    }
    let tag_name = url.rsplit('/').next()?.to_string();
    let name = between(entry, "<title>", "</title>")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&tag_name)
        .to_string();
    let raw_notes = between(entry, "<content", "</content>").unwrap_or("");
    let notes_html = raw_notes
        .split_once('>')
        .map(|(_, rest)| rest)
        .unwrap_or(raw_notes);
    let body = strip_tags(&decode_basic_html(notes_html));
    Some(json!({
        "tag_name": tag_name,
        "name": name,
        "body": body,
        "html_url": url,
    }))
}

fn curl_get(url: &str) -> Result<(String, u16), String> {
    let output = Command::new("curl")
        .args([
            "-sS",
            "-A",
            "AI-Usage",
            "-H",
            "Accept: application/vnd.github+json, application/atom+xml, text/html",
            "-H",
            "X-GitHub-Api-Version: 2022-11-28",
            "-w",
            "\nHTTPSTATUS:%{http_code}",
            url,
        ])
        .output()
        .map_err(|e| format!("无法检查更新：{e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let (body, status) = split_curl_status(&stdout);
    Ok((body.to_string(), status))
}

fn fetch_github_latest_release() -> Result<Value, String> {
    if let Ok((body, status)) = curl_get(GITHUB_LATEST_RELEASE) {
        if status == 200 {
            if let Ok(value) = serde_json::from_str::<Value>(&body) {
                if value.get("tag_name").and_then(Value::as_str).is_some() {
                    return Ok(value);
                }
            }
        }
    }
    let (atom, status) = curl_get(GITHUB_RELEASES_ATOM)?;
    if status != 200 {
        return Err(github_update_error(status));
    }
    parse_releases_atom(&atom).ok_or_else(|| "还没有发布版本".to_string())
}

#[tauri::command]
fn get_state(app: AppHandle) -> DashboardState {
    dashboard_payload(&app)
}

#[tauri::command]
async fn refresh_data(app: AppHandle) -> Result<DashboardState, String> {
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || run_dump_exclusive(&handle))
        .await
        .map_err(|e| e.to_string())?;
    match result {
        Ok(false) => return Ok(dashboard_payload(&app)),
        Ok(true) => set_error(&app, None),
        Err(err) => {
            set_error(&app, Some(err.clone()));
            update_tray_title(&app);
            return Err(err);
        }
    }
    update_tray_title(&app);
    Ok(dashboard_payload(&app))
}

#[tauri::command]
fn save_config(app: AppHandle, patch: Value) -> Result<DashboardState, String> {
    let home = ai_usage_home();
    let mut cfg = ensure_config(&home);
    if let Some(obj) = patch.as_object() {
        for (key, value) in obj {
            cfg[key] = value.clone();
        }
    }
    write_json(&config_path(&home), &cfg)?;
    if let Some(enabled) = patch.get("autostart").and_then(Value::as_bool) {
        let launcher = app.autolaunch();
        if enabled {
            launcher.enable().map_err(|e| e.to_string())?;
        } else {
            launcher.disable().map_err(|e| e.to_string())?;
        }
    }
    apply_window_theme(&app);
    update_tray_title(&app);
    Ok(dashboard_payload(&app))
}

#[tauri::command]
fn quit_command(app: AppHandle) {
    quit_app(&app);
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    open_in_file_manager(&path)
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !is_http_url(&url) {
        return Err("链接无效".into());
    }
    open_target(url.trim())
}

#[tauri::command]
fn check_for_update() -> Result<Value, String> {
    fetch_github_latest_release()
}

#[tauri::command]
fn install_cursor_hook() -> Result<String, String> {
    run_node_script(hook_installer())
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开仪表盘", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "更新数据", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &refresh, &quit])?;

    #[allow(unused_mut)]
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("AI Usage")
        .title("—")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => open_dashboard(app),
            "refresh" => spawn_dump(app.clone()),
            "quit" => quit_app(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                open_dashboard(tray.app_handle());
            }
        });

    #[cfg(not(target_os = "macos"))]
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            open_dashboard(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(AppState {
            last_error: Mutex::new(None),
            dump_busy: Mutex::new(()),
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            refresh_data,
            save_config,
            quit_command,
            open_path,
            open_url,
            check_for_update,
            install_cursor_hook
        ])
        .setup(|app| {
            init_resource_root(&app.handle());
            bootstrap_collectors();
            build_tray(&app.handle())?;
            update_tray_title(&app.handle());

            sync_autostart(&app.handle());
            #[cfg(target_os = "macos")]
            set_activation_policy(&app.handle(), tauri::ActivationPolicy::Accessory);

            let handle = app.handle().clone();
            thread::spawn(move || {
                refresh_and_notify(&handle);
                loop {
                    thread::sleep(DUMP_INTERVAL);
                    refresh_and_notify(&handle);
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != WINDOW_LABEL {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                hide_dashboard_to_tray(window);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building AI Usage");

    app.run(|app, event| {
        match event {
            RunEvent::ExitRequested { api, code, .. } => {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => open_dashboard(app),
            _ => {}
        }
    });
}

#[cfg(test)]
mod dump_lock_tests {
    use super::*;

    #[test]
    fn overlapping_dump_lock_skips() {
        let lock = Mutex::new(());
        let _hold = lock.lock().unwrap();
        assert!(try_with_dump_lock(&lock, || ()).is_none());
    }

    #[test]
    fn dump_lock_runs_when_free() {
        let lock = Mutex::new(());
        assert_eq!(try_with_dump_lock(&lock, || 7), Some(7));
    }

    #[test]
    fn normalize_hostname_strips_local_suffix() {
        assert_eq!(normalize_hostname("Huffies-Mac-mini.local"), "Huffies-Mac-mini");
        assert_eq!(normalize_hostname("  desk-1  "), "desk-1");
    }

    #[test]
    fn http_urls_are_detected() {
        assert!(is_http_url("https://github.com/HaofeiMa/ai-usage"));
        assert!(!is_http_url("/tmp/extension"));
    }

    #[test]
    fn github_update_error_maps_forbidden() {
        assert_eq!(github_update_error(403), "GitHub 暂时拒绝了检查请求，请稍后重试");
        assert_eq!(github_update_error(404), "还没有发布版本");
    }

    #[test]
    fn split_curl_status_reads_trailer() {
        let (body, status) = split_curl_status("{\"tag_name\":\"v1\"}\nHTTPSTATUS:200");
        assert_eq!(body, "{\"tag_name\":\"v1\"}");
        assert_eq!(status, 200);
    }

    #[test]
    fn parse_releases_atom_reads_first_entry() {
        let xml = r#"<?xml version="1.0"?>
<feed>
  <entry>
    <link rel="alternate" type="text/html" href="https://github.com/HaofeiMa/ai-usage/releases/tag/v0.1.0"/>
    <title>AI Usage v0.1.0</title>
    <content type="html">&lt;p&gt;first mac build&lt;/p&gt;</content>
  </entry>
</feed>"#;
        let value = parse_releases_atom(xml).expect("atom");
        assert_eq!(value["tag_name"], "v0.1.0");
        assert_eq!(value["name"], "AI Usage v0.1.0");
        assert_eq!(
            value["html_url"],
            "https://github.com/HaofeiMa/ai-usage/releases/tag/v0.1.0"
        );
        assert!(value["body"].as_str().unwrap().contains("first mac build"));
    }

    #[test]
    fn theme_from_config_pins_explicit_choice() {
        assert_eq!(theme_from_config(&json!({"theme": "light"})), Some(tauri::Theme::Light));
        assert_eq!(theme_from_config(&json!({"theme": "dark"})), Some(tauri::Theme::Dark));
        assert_eq!(theme_from_config(&json!({"theme": "system"})), None);
        assert_eq!(theme_from_config(&json!({})), None);
    }

    #[test]
    fn dump_script_from_joins_sidecar() {
        assert_eq!(
            dump_script_from(Path::new("/bundle")),
            PathBuf::from("/bundle/sidecar/dump.mjs")
        );
        assert_eq!(
            extension_path_from(Path::new("/bundle")),
            PathBuf::from("/bundle/extension")
        );
        assert_eq!(
            hook_installer_from(Path::new("/bundle")),
            PathBuf::from("/bundle/sidecar/install-cursor-hook.mjs")
        );
        assert_eq!(
            native_host_installer_from(Path::new("/bundle")),
            PathBuf::from("/bundle/sidecar/install-native-host.mjs")
        );
    }
}
