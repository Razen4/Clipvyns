mod clipboard;
mod database;
mod model;

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use database::Database;
use image::ImageFormat;
use model::ClipboardItem;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    database: Database,
    image_directory: PathBuf,
    device_name: String,
    last_observed_hash: Arc<Mutex<Option<String>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalDeviceInfo {
    name: String,
    platform: String,
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
fn get_local_device_info() -> LocalDeviceInfo {
    LocalDeviceInfo {
        name: host_name(),
        platform: platform_name().into(),
    }
}

#[tauri::command]
async fn paste_clipboard_item(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    id: String,
) -> Result<PasteResult, AppError> {
    let item = state
        .database
        .find_by_id(&id)?
        .ok_or_else(|| AppError::Message("clipboard item no longer exists".into()))?;
    clipboard::restore_item(&state, item)?;
    leave_foreground_for_paste(&app, &window)?;

    let app_for_paste = app.clone();
    let paste_result = tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(std::time::Duration::from_millis(450));
        paste_shortcut_on_main_thread(&app_for_paste)
    })
    .await
    .map_err(|error| AppError::Message(format!("native paste task failed: {error}")))?;

    match paste_result {
        Ok(()) => Ok(PasteResult {
            pasted: true,
            permission_required: false,
        }),
        Err(clipboard::PasteShortcutError::PermissionRequired) => {
            restore_after_failed_paste(&app, &window);
            Ok(PasteResult {
                pasted: false,
                permission_required: true,
            })
        }
        Err(clipboard::PasteShortcutError::Other(error)) => {
            restore_after_failed_paste(&app, &window);
            Err(error)
        }
    }
}

fn paste_shortcut_on_main_thread(
    app: &tauri::AppHandle,
) -> Result<(), clipboard::PasteShortcutError> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = sender.send(clipboard::paste_shortcut());
    })
    .map_err(|error| {
        clipboard::PasteShortcutError::Other(AppError::Message(format!(
            "could not schedule native paste on the main thread: {error}"
        )))
    })?;

    receiver.recv().map_err(|_| {
        clipboard::PasteShortcutError::Other(AppError::Message(
            "the application closed before native paste could run".into(),
        ))
    })?
}

#[tauri::command]
fn reveal_application(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    app.show().map_err(tauri_error)?;
    window.show().map_err(tauri_error)?;
    window.unminimize().map_err(tauri_error)?;
    window.set_focus().map_err(tauri_error)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PasteResult {
    pasted: bool,
    permission_required: bool,
}

#[tauri::command]
fn delete_clipboard_item(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    if let Some(item) = state.database.delete_by_id(&id)? {
        remove_item_files(item);
    }
    Ok(())
}

#[tauri::command]
fn delete_clipboard_item_by_hash(
    state: State<'_, AppState>,
    content_hash: String,
) -> Result<(), AppError> {
    if let Some(item) = state.database.delete_by_hash(&content_hash)? {
        remove_item_files(item);
    }
    Ok(())
}

#[tauri::command]
fn set_clipboard_item_pinned(
    state: State<'_, AppState>,
    id: String,
    pinned: bool,
) -> Result<(), AppError> {
    state.database.set_pinned_by_id(&id, pinned)
}

#[tauri::command]
fn update_clipboard_item_sync_metadata(
    state: State<'_, AppState>,
    content_hash: String,
    created_at: i64,
    source_device: String,
    pinned: bool,
) -> Result<(), AppError> {
    if created_at <= 0 || source_device.len() > 256 {
        return Err(AppError::Message(
            "remote clipboard metadata is invalid".into(),
        ));
    }
    state
        .database
        .update_sync_metadata_by_hash(&content_hash, created_at, &source_device, pinned)
}

fn remove_item_files(item: model::StoredItem) {
    for path in [item.image_path, item.thumbnail_path].into_iter().flatten() {
        if let Err(error) = std::fs::remove_file(&path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            eprintln!("failed to remove clipboard image {path}: {error}");
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteTextItem {
    id: String,
    text_content: String,
    content_hash: String,
    created_at: i64,
    source_device: String,
    #[serde(default)]
    pinned: bool,
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
        pinned: false,
    })?;
    state
        .database
        .set_pinned_by_hash(&item.content_hash, item.pinned)?;
    Ok(())
}

#[tauri::command]
fn read_local_image(state: State<'_, AppState>, id: String) -> Result<String, AppError> {
    let item = state
        .database
        .find_by_id(&id)?
        .ok_or_else(|| AppError::Message("clipboard item no longer exists".into()))?;
    if item.item.kind != "image" {
        return Err(AppError::Message("clipboard item is not an image".into()));
    }
    let path = item
        .image_path
        .ok_or_else(|| AppError::Message("image item has no local file".into()))?;
    Ok(STANDARD.encode(std::fs::read(path)?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteImageItem {
    id: String,
    content_hash: String,
    created_at: i64,
    source_device: String,
    width: u32,
    height: u32,
    mime_type: String,
    #[serde(default)]
    pinned: bool,
}

#[tauri::command]
fn import_remote_image(
    state: State<'_, AppState>,
    item: RemoteImageItem,
    png_base64: String,
) -> Result<(), AppError> {
    if item.id.len() > 128
        || Uuid::parse_str(&item.id).is_err()
        || item.source_device.len() > 256
        || item.created_at <= 0
        || item.mime_type != "image/png"
    {
        return Err(AppError::Message("remote image metadata is invalid".into()));
    }
    let png = STANDARD
        .decode(png_base64)
        .map_err(|_| AppError::Message("remote image is not valid base64".into()))?;
    if png.is_empty() || png.len() > 25 * 1024 * 1024 {
        return Err(AppError::Message(
            "remote image exceeds the 25 MiB limit".into(),
        ));
    }
    let image = image::load_from_memory_with_format(&png, ImageFormat::Png)?;
    let rgba = image.into_rgba8();
    let (width, height) = rgba.dimensions();
    if width != item.width
        || height != item.height
        || clipboard::image_hash(width, height, rgba.as_raw()) != item.content_hash
    {
        return Err(AppError::Message(
            "remote image failed integrity validation".into(),
        ));
    }

    if state.database.find_by_hash(&item.content_hash)?.is_some() {
        return Ok(());
    }
    let image_path = state.image_directory.join(format!("{}.png", item.id));
    let thumbnail_path = state.image_directory.join(format!("{}.thumb.png", item.id));
    clipboard::write_png_atomically(&image::DynamicImage::ImageRgba8(rgba.clone()), &image_path)?;
    clipboard::write_png_atomically(
        &image::DynamicImage::ImageRgba8(rgba).thumbnail(320, 180),
        &thumbnail_path,
    )?;
    if let Err(error) = state.database.upsert(database::NewItem {
        id: &item.id,
        kind: "image",
        text_content: None,
        image_path: Some(&image_path),
        thumbnail_path: Some(&thumbnail_path),
        content_hash: &item.content_hash,
        created_at: item.created_at,
        source_device: &item.source_device,
        width: Some(width),
        height: Some(height),
        mime_type: Some("image/png"),
        pinned: false,
    }) {
        let _ = std::fs::remove_file(image_path);
        let _ = std::fs::remove_file(thumbnail_path);
        return Err(error);
    }
    state
        .database
        .set_pinned_by_hash(&item.content_hash, item.pinned)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn leave_foreground_for_paste(
    app: &tauri::AppHandle,
    _window: &tauri::WebviewWindow,
) -> Result<(), AppError> {
    app.hide().map_err(tauri_error)
}

#[cfg(not(target_os = "macos"))]
fn leave_foreground_for_paste(
    _app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
) -> Result<(), AppError> {
    window.minimize().map_err(tauri_error)
}

fn restore_after_failed_paste(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    if let Err(error) = app.show() {
        eprintln!("failed to show app after paste error: {error}");
    }
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
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::Builder::new().build());

    builder
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
            get_local_device_info,
            reveal_application,
            list_clipboard_items,
            paste_clipboard_item,
            delete_clipboard_item,
            delete_clipboard_item_by_hash,
            set_clipboard_item_pinned,
            update_clipboard_item_sync_metadata,
            import_remote_text_item,
            read_local_image,
            import_remote_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running clipboard application");
}

fn device_name() -> String {
    format!("{} · {}", host_name(), platform_name())
}

fn host_name() -> String {
    hostname::get()
        .ok()
        .and_then(|value| value.into_string().ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "This device".into())
}

fn platform_name() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    }
}
