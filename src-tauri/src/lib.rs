#[cfg(desktop)]
mod clipboard;
#[cfg(desktop)]
mod database;
#[cfg(desktop)]
mod desktop;
#[cfg(desktop)]
mod model;
#[cfg(mobile)]
mod mobile;

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
        .plugin(mobile::init())
        .invoke_handler(tauri::generate_handler![mobile::save_image_to_device])
        .run(tauri::generate_context!())
        .expect("error while running Clipvyn Companion");
}
