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

pub(crate) fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("image-saver-native")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle = api.register_android_plugin(
                ANDROID_PLUGIN_IDENTIFIER,
                "ImageSaverPlugin",
            )?;
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
