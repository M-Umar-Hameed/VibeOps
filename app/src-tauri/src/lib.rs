use std::fs::{File, OpenOptions};
use std::io::Write;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::path::BaseDirectory;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_window_state::StateFlags;

struct Sidecar(Mutex<Option<Child>>);

fn port_in_use(port: u16) -> bool {
    TcpStream::connect_timeout(&format!("127.0.0.1:{port}").parse().unwrap(), Duration::from_millis(300)).is_ok()
}

pub const SIDECAR_LOG_CAP: u64 = 10 * 1024 * 1024;

/// Same rule as src/runtime/home.ts: VIBEOPS_HOME, else the OS home dir.
pub fn sidecar_log_path(vibeops_home: Option<std::ffi::OsString>, home: PathBuf) -> PathBuf {
    vibeops_home.map(PathBuf::from).unwrap_or(home)
        .join(".vibeops").join("logs").join("sidecar.log")
}

/// Creates the logs dir, rotates to sidecar.log.1 (replacing it) when over `cap`,
/// and opens the log for append.
pub fn open_sidecar_log(path: &Path, cap: u64) -> std::io::Result<File> {
    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir)?; }
    if std::fs::metadata(path).map(|m| m.len() > cap).unwrap_or(false) {
        let rotated = path.with_extension("log.1");
        let _ = std::fs::remove_file(&rotated);
        std::fs::rename(path, &rotated)?;
    }
    OpenOptions::new().create(true).append(true).open(path)
}

pub fn log_line(path: &Path, msg: &str) {
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "[unix {ts}] {msg}");
    }
}

fn app_sidecar_log_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let home = app.path().home_dir().ok()?;
    Some(sidecar_log_path(std::env::var_os("VIBEOPS_HOME"), home))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        // VISIBLE is excluded deliberately: close-to-tray hides the window, and
        // persisting that would restore a hidden window on the next launch.
        .plugin(tauri_plugin_window_state::Builder::new()
            .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
            .build())
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            let show_item = MenuItem::with_id(app, "show", "Show VibeOps", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit VibeOps", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            // Stable id: without it Tauri assigns a new tray id every launch, so Windows
            // persists a fresh NotifyIconSettings entry each run and stacks duplicate
            // tray icons that survive reboots.
            let mut tray = TrayIconBuilder::with_id("vibeops-tray").tooltip("VibeOps");
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            if let Some(window) = app.get_webview_window("main") {
                let win = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win.hide();
                    }
                });
                if !std::env::args().any(|a| a == "--minimized") {
                    let _ = window.show();
                }
            }

            // ponytail: enable only when not already enabled, so disabling it in
            // Windows Startup settings sticks. A first-run-only flag (tauri-plugin-store
            // is already a dep) would also let the user keep it off while we never retry.
            if app.autolaunch().is_enabled().unwrap_or(false) == false {
                let _ = app.autolaunch().enable();
            }

            let port = std::env::var("PORT").unwrap_or_else(|_| "8787".to_string());
            if port_in_use(port.parse().unwrap_or(8787)) {
                return Ok(()); // dev server / other instance already serving
            }
            let resources = app.path().resolve("resources", BaseDirectory::Resource)?;
            // macOS fell into the linux-x64 branch, so a mac bundle looked for a Linux
            // binary and always took the "sidecar resources missing" path. Runners are
            // Apple Silicon; an Intel bundle would need darwin-x64 fetched and matched
            // here too.
            let node = if cfg!(windows) {
                resources.join("node").join("win-x64").join("node.exe")
            } else if cfg!(target_os = "macos") {
                resources.join("node").join("darwin-arm64").join("node")
            } else {
                resources.join("node").join("linux-x64").join("node")
            };
            let server = resources.join("server").join("server.mjs");
            let migrations = resources.join("server").join("drizzle");
            if !node.exists() || !server.exists() {
                eprintln!("sidecar resources missing; app will use Settings fallback");
                return Ok(());
            }
            let log_path = app_sidecar_log_path(app.handle());
            let log_file = log_path.as_deref().and_then(|p| match open_sidecar_log(p, SIDECAR_LOG_CAP) {
                Ok(f) => Some(f),
                Err(e) => { eprintln!("sidecar log open failed: {e}"); None }
            });
            let mut cmd = Command::new(&node);
            // V8 sizes its default old-space from total RAM, which on a 16 GB box is
            // multiple GB of headroom the sidecar never needs - and headroom it will
            // happily commit under load. Cap it; PGlite's WASM heap and the ONNX
            // runtime live outside this budget, so it only bounds JS objects.
            // Raise VIBEOPS_NODE_MAX_OLD_SPACE if a large ingest ever needs more.
            let max_old_space =
                std::env::var("VIBEOPS_NODE_MAX_OLD_SPACE").unwrap_or_else(|_| "1024".to_string());
            cmd.arg(format!("--max-old-space-size={max_old_space}"))
                .arg(&server)
                .stdin(Stdio::piped())
                .env_remove("DATABASE_URL")
                .env("PORT", &port)
                .env("VIBEOPS_MIGRATIONS_DIR", &migrations);
            match log_file.as_ref().map(|f| (f.try_clone(), f.try_clone())) {
                Some((Ok(out), Ok(err))) => { cmd.stdout(out).stderr(err); }
                _ => { cmd.stdout(Stdio::null()).stderr(Stdio::null()); }
            }
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            if let Some(p) = &log_path { log_line(p, &format!("sidecar start: {} {}", node.display(), server.display())); }
            match cmd.spawn() {
                Ok(child) => { *app.state::<Sidecar>().0.lock().unwrap() = Some(child); }
                Err(e) => {
                    if let Some(p) = &log_path { log_line(p, &format!("sidecar spawn failed: {e}")); }
                    eprintln!("sidecar spawn failed: {e}");
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }) {
                if let Some(mut child) = app.state::<Sidecar>().0.lock().unwrap().take() {
                    // Drop the sidecar's stdin: EOF tells Node to checkpoint the
                    // embedded database and exit cleanly. Wait up to ~5s, then
                    // hard-kill only as a last resort.
                    drop(child.stdin.take());
                    let mut status = None;
                    for _ in 0..50 {
                        match child.try_wait() {
                            Ok(Some(s)) => { status = Some(s); break; }
                            _ => std::thread::sleep(Duration::from_millis(100)),
                        }
                    }
                    // ponytail: a child that dies on its own is only noticed here, at
                    // app exit; seeing it when it happens needs a watcher thread.
                    let line = match status {
                        Some(s) => format!("sidecar exited: {s}"),
                        None => {
                            let _ = child.kill();
                            match child.wait() {
                                Ok(s) => format!("sidecar hard-killed after 5s wait: {s}"),
                                Err(e) => format!("sidecar hard-killed after 5s wait; wait failed: {e}"),
                            }
                        }
                    };
                    if let Some(p) = app_sidecar_log_path(app) { log_line(&p, &line); }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vibeops-sidecar-log-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn path_uses_vibeops_home_when_set() {
        let p = sidecar_log_path(Some("/vh".into()), PathBuf::from("/home/u"));
        assert_eq!(p, PathBuf::from("/vh").join(".vibeops").join("logs").join("sidecar.log"));
    }

    #[test]
    fn path_falls_back_to_home() {
        let p = sidecar_log_path(None, PathBuf::from("/home/u"));
        assert_eq!(p, PathBuf::from("/home/u").join(".vibeops").join("logs").join("sidecar.log"));
    }

    #[test]
    fn creates_dir_and_appends_under_cap() {
        let d = tmp("under");
        let p = d.join("logs").join("sidecar.log");
        drop(open_sidecar_log(&p, 100).unwrap());
        log_line(&p, "a");
        drop(open_sidecar_log(&p, 100).unwrap());
        assert!(!p.with_extension("log.1").exists());
        assert!(std::fs::read_to_string(&p).unwrap().contains("] a"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn rotates_over_cap_and_replaces_old_rotation() {
        let d = tmp("over");
        let p = d.join("logs").join("sidecar.log");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p.with_extension("log.1"), "stale").unwrap();
        std::fs::write(&p, "x".repeat(11)).unwrap();
        drop(open_sidecar_log(&p, 10).unwrap());
        assert_eq!(std::fs::read_to_string(p.with_extension("log.1")).unwrap(), "x".repeat(11));
        assert_eq!(std::fs::metadata(&p).unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(&d);
    }
}
