ALTER TABLE clipboard_items ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_clipboard_items_pinned_created_at
    ON clipboard_items (pinned DESC, created_at DESC);
