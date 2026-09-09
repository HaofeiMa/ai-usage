mod usage;

use chrono::Local;
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
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

fn ensure_config(home: &Path) -> Value {
    let _ = fs::create_dir_all(home);
    let mut cfg = load_config(home);
    let mut dirty = false;
    if cfg.get("includeChatgptInTotal").and_then(Value::as_bool).is_none() {
        cfg["includeChatgptInTotal"] = json!(true);
        dirty = true;
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

fn extension_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../extension")
}

fn dump_script() -> PathBuf {
    if let Ok(p) = std::env::var("AI_USAGE_DUMP") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sidecar/dump.mjs")
}

fn find_node() -> PathBuf {
    if let Ok(p) = std::env::var("AI_USAGE_NODE") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
        if Path::new(candidate).exists() {
            return PathBuf::from(candidate);
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
    }
}

fn update_tray_title(app: &AppHandle) {
    let home = ai_usage_home();
    let include = include_chatgpt(&ensure_config(&home));
    let label = match load_json(&snapshot_path(&home)) {
        Some(Value::Object(map)) => {
            let buckets = map.get("buckets").and_then(Value::as_array);
            usage::tray_label(
                buckets.map(|v| v.as_slice()).unwrap_or(&[]),
                include,
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

fn open_dashboard(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    set_activation_policy(app, tauri::ActivationPolicy::Regular);

    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let builder = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App("index.html".into()))
        .title("AI Usage")
        .inner_size(1120.0, 800.0)
        .min_inner_size(860.0, 600.0)
        .resizable(true)
        .skip_taskbar(true)
        .visible(true);
    if let Ok(window) = builder.build() {
        let _ = window.set_focus();
    }
}

fn quit_app(app: &AppHandle) {
    app.exit(0);
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
    update_tray_title(&app);
    Ok(dashboard_payload(&app))
}

#[tauri::command]
fn quit_command(app: AppHandle) {
    quit_app(&app);
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开仪表盘", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "更新数据", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &refresh, &quit])?;

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

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone()).icon_as_template(true);
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
            quit_command
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            build_tray(&app.handle())?;
            update_tray_title(&app.handle());

            sync_autostart(&app.handle());

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
                let _ = window.destroy();
            }
            if let WindowEvent::Destroyed = event {
                #[cfg(target_os = "macos")]
                set_activation_policy(window.app_handle(), tauri::ActivationPolicy::Accessory);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building AI Usage");

    app.run(|_app, event| {
        if let RunEvent::ExitRequested { api, code, .. } = event {
            if code.is_none() {
                api.prevent_exit();
            }
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
}
