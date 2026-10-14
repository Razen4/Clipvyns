use std::{
    borrow::Cow,
    path::Path,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use arboard::{Clipboard, ImageData};
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use image::{DynamicImage, ImageFormat, RgbaImage};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::{AppError, AppState, database::NewItem, model::StoredItem};

const POLL_INTERVAL: Duration = Duration::from_millis(450);

pub fn start_watcher(app: AppHandle, state: AppState) {
    thread::Builder::new()
        .name("clipboard-watcher".into())
        .spawn(move || watch_loop(app, state))
        .expect("failed to start clipboard watcher");
}

fn watch_loop(app: AppHandle, state: AppState) {
    let mut clipboard: Option<Clipboard> = None;
    loop {
        if clipboard.is_none() {
            match Clipboard::new() {
                Ok(value) => clipboard = Some(value),
                Err(error) => {
                    eprintln!("clipboard unavailable: {error}");
                    thread::sleep(Duration::from_secs(2));
                    continue;
                }
            }
        }

        let result = capture_current(clipboard.as_mut().expect("clipboard initialized"), &state);
        match result {
            Ok(Some(stored)) => {
                if let Err(error) = app.emit("clipboard://changed", &stored.item) {
                    eprintln!("failed to emit clipboard change: {error}");
                }
            }
            Ok(None) => {}
            Err(error) => eprintln!("clipboard capture failed: {error}"),
        }
        thread::sleep(POLL_INTERVAL);
    }
}

fn capture_current(
    clipboard: &mut Clipboard,
    state: &AppState,
) -> Result<Option<StoredItem>, AppError> {
    if let Ok(image) = clipboard.get_image() {
        let bytes = image.bytes.into_owned();
        let width = u32::try_from(image.width)
            .map_err(|_| AppError::Message("clipboard image width is too large".into()))?;
        let height = u32::try_from(image.height)
            .map_err(|_| AppError::Message("clipboard image height is too large".into()))?;
        let hash = image_hash(width, height, &bytes);
        if is_observed(&state.last_observed_hash, &hash) {
            return Ok(None);
        }
        let stored = capture_image(state, hash.clone(), width, height, bytes)?;
        set_observed(&state.last_observed_hash, hash);
        return Ok(Some(stored));
    }

    if let Ok(text) = clipboard.get_text() {
        if text.is_empty() {
            return Ok(None);
        }
        let hash = text_hash(&text);
        if is_observed(&state.last_observed_hash, &hash) {
            return Ok(None);
        }
        let id = Uuid::new_v4().to_string();
        let stored = state.database.upsert(NewItem {
            id: &id,
            kind: "text",
            text_content: Some(&text),
            image_path: None,
            thumbnail_path: None,
            content_hash: &hash,
            created_at: now_millis(),
            source_device: &state.device_name,
            width: None,
            height: None,
            mime_type: Some("text/plain"),
        })?;
        set_observed(&state.last_observed_hash, hash);
        return Ok(Some(stored));
    }

    Ok(None)
}

fn capture_image(
    state: &AppState,
    hash: String,
    width: u32,
    height: u32,
    bytes: Vec<u8>,
) -> Result<StoredItem, AppError> {
    if let Some(existing) = state.database.find_by_hash(&hash)? {
        return state.database.upsert(NewItem {
            id: &existing.item.id,
            kind: "image",
            text_content: None,
            image_path: existing.image_path.as_deref().map(Path::new),
            thumbnail_path: existing.thumbnail_path.as_deref().map(Path::new),
            content_hash: &hash,
            created_at: now_millis(),
            source_device: &state.device_name,
            width: Some(width),
            height: Some(height),
            mime_type: Some("image/png"),
        });
    }

    let rgba = RgbaImage::from_raw(width, height, bytes)
        .ok_or_else(|| AppError::Message("clipboard returned malformed RGBA image data".into()))?;
    let id = Uuid::new_v4().to_string();
    let image_path = state.image_directory.join(format!("{id}.png"));
    let thumbnail_path = state.image_directory.join(format!("{id}.thumb.png"));
    write_png_atomically(&DynamicImage::ImageRgba8(rgba.clone()), &image_path)?;
    write_png_atomically(
        &DynamicImage::ImageRgba8(rgba).thumbnail(320, 180),
        &thumbnail_path,
    )?;

    match state.database.upsert(NewItem {
        id: &id,
        kind: "image",
        text_content: None,
        image_path: Some(&image_path),
        thumbnail_path: Some(&thumbnail_path),
        content_hash: &hash,
        created_at: now_millis(),
        source_device: &state.device_name,
        width: Some(width),
        height: Some(height),
        mime_type: Some("image/png"),
    }) {
        Ok(item) => Ok(item),
        Err(error) => {
            let _ = std::fs::remove_file(image_path);
            let _ = std::fs::remove_file(thumbnail_path);
            Err(error)
        }
    }
}

pub fn restore_item(state: &AppState, stored: StoredItem) -> Result<(), AppError> {
    {
        let mut observed = state
            .last_observed_hash
            .lock()
            .map_err(|_| AppError::Message("clipboard watcher state is poisoned".into()))?;
        *observed = Some(stored.item.content_hash.clone());
    }

    let mut clipboard = Clipboard::new()?;
    match stored.item.kind.as_str() {
        "text" => clipboard.set_text(
            stored
                .item
                .text_content
                .ok_or_else(|| AppError::Message("text item has no content".into()))?,
        )?,
        "image" => {
            let path = stored
                .image_path
                .ok_or_else(|| AppError::Message("image item has no local file".into()))?;
            let rgba = image::open(path)?.into_rgba8();
            let (width, height) = rgba.dimensions();
            clipboard.set_image(ImageData {
                width: width as usize,
                height: height as usize,
                bytes: Cow::Owned(rgba.into_raw()),
            })?;
        }
        kind => {
            return Err(AppError::Message(format!(
                "unsupported clipboard item kind: {kind}"
            )));
        }
    }
    Ok(())
}

pub fn paste_shortcut() -> Result<(), AppError> {
    let mut keyboard = Enigo::new(&Settings::default()).map_err(|error| {
        AppError::Message(format!(
            "cannot create native input controller: {error}. On macOS, allow Clipboard Sharings in System Settings > Privacy & Security > Accessibility, then reopen the app"
        ))
    })?;

    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;

    keyboard
        .key(modifier, Direction::Press)
        .map_err(input_error)?;
    let paste_result = keyboard
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(input_error);
    let release_result = keyboard
        .key(modifier, Direction::Release)
        .map_err(input_error);
    paste_result?;
    release_result
}

fn input_error(error: enigo::InputError) -> AppError {
    AppError::Message(format!(
        "native paste was blocked: {error}. On macOS, allow Clipboard Sharings in System Settings > Privacy & Security > Accessibility"
    ))
}

fn write_png_atomically(image: &DynamicImage, destination: &Path) -> Result<(), AppError> {
    let temporary = destination.with_extension("png.tmp");
    image.save_with_format(&temporary, ImageFormat::Png)?;
    std::fs::rename(temporary, destination)?;
    Ok(())
}

fn is_observed(last_hash: &Arc<Mutex<Option<String>>>, current_hash: &str) -> bool {
    let Ok(last) = last_hash.lock() else {
        return false;
    };
    last.as_deref() == Some(current_hash)
}

fn set_observed(last_hash: &Arc<Mutex<Option<String>>>, current_hash: String) {
    if let Ok(mut last) = last_hash.lock() {
        *last = Some(current_hash);
    }
}

pub(crate) fn text_hash(text: &str) -> String {
    hash_parts(&[b"text\0", text.as_bytes()])
}

fn image_hash(width: u32, height: u32, bytes: &[u8]) -> String {
    hash_parts(&[
        b"image\0",
        &width.to_le_bytes(),
        &height.to_le_bytes(),
        bytes,
    ])
}

fn hash_parts(parts: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    format!("{:x}", hasher.finalize())
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_include_type_and_image_dimensions() {
        assert_ne!(text_hash("same"), hash_parts(&[b"image\0", b"same"]));
        assert_ne!(image_hash(1, 2, &[0; 8]), image_hash(2, 1, &[0; 8]));
        assert_eq!(text_hash("stable"), text_hash("stable"));
    }

    #[test]
    fn observed_hash_only_changes_once() {
        let state = Arc::new(Mutex::new(None));
        assert!(!is_observed(&state, "one"));
        set_observed(&state, "one".into());
        assert!(is_observed(&state, "one"));
        assert!(!is_observed(&state, "two"));
    }

    #[test]
    fn persists_full_image_and_thumbnail() {
        let directory = tempfile::tempdir().unwrap();
        let image_directory = directory.path().join("images");
        std::fs::create_dir(&image_directory).unwrap();
        let state = AppState {
            database: crate::database::Database::initialize(directory.path().join("history.db"))
                .unwrap(),
            image_directory,
            device_name: "Test Mac".into(),
            last_observed_hash: Arc::new(Mutex::new(None)),
        };
        let pixels = vec![255_u8; 800 * 400 * 4];
        let stored =
            capture_image(&state, image_hash(800, 400, &pixels), 800, 400, pixels).unwrap();

        assert!(Path::new(stored.image_path.as_ref().unwrap()).is_file());
        assert!(Path::new(stored.thumbnail_path.as_ref().unwrap()).is_file());
        let thumbnail = image::open(stored.thumbnail_path.unwrap()).unwrap();
        assert_eq!((thumbnail.width(), thumbnail.height()), (320, 160));
        assert!(
            state.database.list("").unwrap()[0]
                .preview_data_url
                .as_deref()
                .unwrap()
                .starts_with("data:image/png;base64,")
        );
    }

    #[test]
    #[ignore = "requires an interactive desktop clipboard"]
    fn restores_text_and_image_to_native_clipboard() {
        let directory = tempfile::tempdir().unwrap();
        let image_directory = directory.path().join("images");
        std::fs::create_dir(&image_directory).unwrap();
        let state = AppState {
            database: crate::database::Database::initialize(directory.path().join("history.db"))
                .unwrap(),
            image_directory,
            device_name: "Test Mac".into(),
            last_observed_hash: Arc::new(Mutex::new(None)),
        };
        let previous_text = Clipboard::new().unwrap().get_text().ok();

        let text = "native restore smoke test";
        let text_item = state
            .database
            .upsert(NewItem {
                id: "restore-text",
                kind: "text",
                text_content: Some(text),
                image_path: None,
                thumbnail_path: None,
                content_hash: &text_hash(text),
                created_at: now_millis(),
                source_device: &state.device_name,
                width: None,
                height: None,
                mime_type: Some("text/plain"),
            })
            .unwrap();
        restore_item(&state, text_item).unwrap();
        assert_eq!(Clipboard::new().unwrap().get_text().unwrap(), text);

        let pixels = vec![127_u8; 3 * 2 * 4];
        let image_item = capture_image(&state, image_hash(3, 2, &pixels), 3, 2, pixels).unwrap();
        restore_item(&state, image_item).unwrap();
        let restored = Clipboard::new().unwrap().get_image().unwrap();
        assert_eq!((restored.width, restored.height), (3, 2));

        if let Some(previous_text) = previous_text {
            Clipboard::new().unwrap().set_text(previous_text).unwrap();
        }
    }
}
