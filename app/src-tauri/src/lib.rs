use std::net::TcpStream;
use std::process::{Child, Command};
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
            let node = if cfg!(windows) {
                resources.join("node").join("win-x64").join("node.exe")
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
                    let _ = child.kill();
                }
            }
        });
}
