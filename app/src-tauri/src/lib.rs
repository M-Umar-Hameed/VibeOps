use std::net::TcpStream;
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
            let mut tray = TrayIconBuilder::new().tooltip("VibeOps");
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
            let mut cmd = Command::new(&node);
            cmd.arg(&server)
                .stdin(Stdio::piped())
                .env_remove("DATABASE_URL")
                .env("PORT", &port)
                .env("VIBEOPS_MIGRATIONS_DIR", &migrations);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            match cmd.spawn() {
                Ok(child) => { *app.state::<Sidecar>().0.lock().unwrap() = Some(child); }
                Err(e) => eprintln!("sidecar spawn failed: {e}"),
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
                    let mut exited = false;
                    for _ in 0..50 {
                        match child.try_wait() {
                            Ok(Some(_)) => { exited = true; break; }
                            _ => std::thread::sleep(Duration::from_millis(100)),
                        }
                    }
                    if !exited { let _ = child.kill(); }
                }
            }
        });
}
