use serde::{Deserialize, Serialize};
use tauri::{
    Manager, Runtime, State, Wry,
    plugin::{Builder, PluginHandle, TauriPlugin},
};

const ANDROID_PLUGIN_IDENTIFIER: &str = "com.razencdev.clipboard_sharings";

pub(crate) struct ImageSaver<R: Runtime>(PluginHandle<R>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveImageArgs {
    file_name: String,
    data_base64: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedImage {
    pub(crate) file_name: String,
    pub(crate) location: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallUpdateArgs {
    apk_url: String,
    version: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateLaunch {
    pub(crate) version: String,
}

pub(crate) fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("image-saver-native")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle =
                api.register_android_plugin(ANDROID_PLUGIN_IDENTIFIER, "ImageSaverPlugin")?;
            app.manage(ImageSaver(handle));
            Ok(())
        })
        .build()
}

#[tauri::command]
pub(crate) fn save_image_to_device(
    state: State<'_, ImageSaver<Wry>>,
    file_name: String,
    data_base64: String,
) -> Result<SavedImage, String> {
    if data_base64.is_empty() || data_base64.len() > 36_000_000 {
        return Err("Image data is empty or too large".into());
    }
    state
        .0
        .run_mobile_plugin(
            "saveImage",
            SaveImageArgs {
                file_name,
                data_base64,
            },
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn install_android_update(
    state: State<'_, ImageSaver<Wry>>,
    apk_url: String,
    version: String,
) -> Result<UpdateLaunch, String> {
    if !apk_url.starts_with("https://") || apk_url.len() > 2_048 {
        return Err("The update download URL is invalid".into());
    }
    let version_parts: Vec<_> = version.split('.').collect();
    if version_parts.len() != 3
        || version_parts.iter().any(|part| {
            part.is_empty() || !part.chars().all(|character| character.is_ascii_digit())
        })
    {
        return Err("The update version is invalid".into());
    }
    state
        .0
        .run_mobile_plugin("installUpdate", InstallUpdateArgs { apk_url, version })
        .map_err(|error| error.to_string())
}
