mod clipboard;
mod database;
mod model;

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use database::Database;
use model::ClipboardItem;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use thiserror::Error;

#[derive(Clone)]
struct AppState {
    database: Database,
    image_directory: PathBuf,
    device_name: String,
    last_observed_hash: Arc<Mutex<Option<String>>>,
}

#[derive(Debug, Error)]
enum AppError {
    #[error("{0}")]
    Message(String),
    #[error("clipboard error: {0}")]
    Clipboard(#[from] arboard::Error),
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("image error: {0}")]
    Image(#[from] image::ImageError),
    #[error("file error: {0}")]
    Io(#[from] std::io::Error),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[tauri::command]
fn list_clipboard_items(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<ClipboardItem>, AppError> {
    state.database.list(&query)
}

#[tauri::command]
async fn paste_clipboard_item(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), AppError> {
    let item = state
        .database
        .find_by_id(&id)?
        .ok_or_else(|| AppError::Message("clipboard item no longer exists".into()))?;
    clipboard::restore_item(&state, item)?;
    minimize_for_paste(&window)?;

    let paste_result = tauri::async_runtime::spawn_blocking(|| {
        std::thread::sleep(std::time::Duration::from_millis(250));
        clipboard::paste_shortcut()
    })
    .await
    .map_err(|error| AppError::Message(format!("native paste task failed: {error}")))?;

    if let Err(error) = paste_result {
        restore_after_failed_paste(&window);
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
fn delete_clipboard_item(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    let item = state
        .database
        .delete_by_id(&id)?
        .ok_or_else(|| AppError::Message("clipboard item no longer exists".into()))?;

    for path in [item.image_path, item.thumbnail_path].into_iter().flatten() {
        if let Err(error) = std::fs::remove_file(&path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            eprintln!("failed to remove clipboard image {path}: {error}");
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteTextItem {
    id: String,
    text_content: String,
    content_hash: String,
    created_at: i64,
    source_device: String,
}

#[tauri::command]
fn import_remote_text_item(
    state: State<'_, AppState>,
    item: RemoteTextItem,
) -> Result<(), AppError> {
    if item.id.len() > 128 || item.source_device.len() > 256 {
        return Err(AppError::Message(
            "remote clipboard metadata is too large".into(),
        ));
    }
    if item.text_content.is_empty() || item.text_content.len() > 1_048_576 {
        return Err(AppError::Message(
            "remote clipboard text must be between 1 byte and 1 MiB".into(),
        ));
    }
    if item.created_at <= 0 || clipboard::text_hash(&item.text_content) != item.content_hash {
        return Err(AppError::Message(
            "remote clipboard item failed integrity validation".into(),
        ));
    }

    state.database.upsert(database::NewItem {
        id: &item.id,
        kind: "text",
        text_content: Some(&item.text_content),
        image_path: None,
        thumbnail_path: None,
        content_hash: &item.content_hash,
        created_at: item.created_at,
        source_device: &item.source_device,
        width: None,
        height: None,
        mime_type: Some("text/plain"),
    })?;
    Ok(())
}

fn minimize_for_paste(window: &tauri::WebviewWindow) -> Result<(), AppError> {
    window.minimize().map_err(tauri_error)
}

fn restore_after_failed_paste(window: &tauri::WebviewWindow) {
    if let Err(error) = window.unminimize() {
        eprintln!("failed to restore window after paste error: {error}");
    }
    if let Err(error) = window.set_focus() {
        eprintln!("failed to focus window after paste error: {error}");
    }
}

fn tauri_error(error: tauri::Error) -> AppError {
    AppError::Message(format!("window operation failed: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            let image_directory = app_data.join("images");
            std::fs::create_dir_all(&image_directory)?;
            let state = AppState {
                database: Database::initialize(app_data.join("clipboard.db"))
                    .map_err(|error| Box::<dyn std::error::Error>::from(error.to_string()))?,
                image_directory,
                device_name: device_name(),
                last_observed_hash: Arc::new(Mutex::new(None)),
            };
            app.manage(state.clone());
            clipboard::start_watcher(app.handle().clone(), state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_clipboard_items,
            paste_clipboard_item,
            delete_clipboard_item,
            import_remote_text_item
        ])
        .run(tauri::generate_context!())
        .expect("error while running clipboard application");
}

fn device_name() -> String {
    let hostname = hostname::get()
        .ok()
        .and_then(|value| value.into_string().ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "This device".into());
    format!("{} · {}", hostname, std::env::consts::OS)
}
