CREATE TABLE IF NOT EXISTS clipboard_items (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('text', 'image')),
    text_content TEXT,
    image_path TEXT,
    thumbnail_path TEXT,
    content_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    source_device TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    mime_type TEXT,
    CHECK (
        (kind = 'text' AND text_content IS NOT NULL AND image_path IS NULL) OR
        (kind = 'image' AND text_content IS NULL AND image_path IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_clipboard_items_created_at
    ON clipboard_items (created_at DESC);
