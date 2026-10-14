use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardItem {
    pub id: String,
    pub kind: String,
    pub text_content: Option<String>,
    pub preview_data_url: Option<String>,
    pub content_hash: String,
    pub created_at: i64,
    pub source_device: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub mime_type: Option<String>,
}

#[derive(Clone, Debug)]
pub struct StoredItem {
    pub item: ClipboardItem,
    pub image_path: Option<String>,
    pub thumbnail_path: Option<String>,
}
