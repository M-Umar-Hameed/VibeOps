use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::path::BaseDirectory;
use tauri::Manager;

struct Sidecar(Mutex<Option<Child>>);

fn port_in_use(port: u16) -> bool {
    TcpStream::connect_timeout(&format!("127.0.0.1:{port}").parse().unwrap(), Duration::from_millis(300)).is_ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
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
