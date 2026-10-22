#[cfg(desktop)]
mod clipboard;
#[cfg(desktop)]
mod database;
#[cfg(desktop)]
mod desktop;
#[cfg(desktop)]
mod model;

#[cfg(desktop)]
pub(crate) use desktop::{AppError, AppState, prune_history};

#[cfg(desktop)]
pub use desktop::run;

#[cfg(mobile)]
#[tauri::mobile_entry_point]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running Clipvyn Companion");
}
