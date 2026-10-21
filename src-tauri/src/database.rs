use std::path::{Path, PathBuf};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use rusqlite::{Connection, OptionalExtension, params};

use crate::{
    AppError,
    model::{ClipboardItem, StoredItem},
};

const INITIAL_MIGRATION: &str = include_str!("../migrations/0001_clipboard_items.sql");
const PINNED_MIGRATION: &str = include_str!("../migrations/0002_add_pinned.sql");

#[derive(Clone, Debug)]
pub struct Database {
    path: PathBuf,
}

pub struct NewItem<'a> {
    pub id: &'a str,
    pub kind: &'a str,
    pub text_content: Option<&'a str>,
    pub image_path: Option<&'a Path>,
    pub thumbnail_path: Option<&'a Path>,
    pub content_hash: &'a str,
    pub created_at: i64,
    pub source_device: &'a str,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub mime_type: Option<&'a str>,
    pub pinned: bool,
}

impl Database {
    pub fn initialize(path: PathBuf) -> Result<Self, AppError> {
        let database = Self { path };
        let connection = database.open()?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL);",
        )?;
        let migrated = connection
            .query_row(
                "SELECT 1 FROM schema_migrations WHERE version = 1",
                [],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !migrated {
            let transaction = connection.unchecked_transaction()?;
            transaction.execute_batch(INITIAL_MIGRATION)?;
            transaction.execute("INSERT INTO schema_migrations (version) VALUES (1)", [])?;
            transaction.commit()?;
        }
        let pinned_migrated = connection
            .query_row(
                "SELECT 1 FROM schema_migrations WHERE version = 2",
                [],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !pinned_migrated {
            let transaction = connection.unchecked_transaction()?;
            transaction.execute_batch(PINNED_MIGRATION)?;
            transaction.execute("INSERT INTO schema_migrations (version) VALUES (2)", [])?;
            transaction.commit()?;
        }
        Ok(database)
    }

    fn open(&self) -> Result<Connection, AppError> {
        let connection = Connection::open(&self.path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        Ok(connection)
    }

    pub fn upsert(&self, new_item: NewItem<'_>) -> Result<StoredItem, AppError> {
        let connection = self.open()?;
        connection.execute(
            "INSERT INTO clipboard_items (
                id, kind, text_content, image_path, thumbnail_path, content_hash,
                created_at, source_device, width, height, mime_type, pinned
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(content_hash) DO UPDATE SET
                created_at = excluded.created_at,
                source_device = excluded.source_device",
            params![
                new_item.id,
                new_item.kind,
                new_item.text_content,
                new_item.image_path.map(path_to_string),
                new_item.thumbnail_path.map(path_to_string),
                new_item.content_hash,
                new_item.created_at,
                new_item.source_device,
                new_item.width,
                new_item.height,
                new_item.mime_type,
                new_item.pinned,
            ],
        )?;
        self.find_by_hash(new_item.content_hash)?
            .ok_or_else(|| AppError::Message("clipboard item was not persisted".into()))
    }

    pub fn find_by_hash(&self, content_hash: &str) -> Result<Option<StoredItem>, AppError> {
        let connection = self.open()?;
        let mut statement = connection.prepare(
            "SELECT id, kind, text_content, image_path, thumbnail_path, content_hash,
                    created_at, source_device, width, height, mime_type, pinned
             FROM clipboard_items WHERE content_hash = ?1",
        )?;
        statement
            .query_row([content_hash], map_stored_item)
            .optional()
            .map_err(Into::into)
    }

    pub fn find_by_id(&self, id: &str) -> Result<Option<StoredItem>, AppError> {
        let connection = self.open()?;
        let mut statement = connection.prepare(
            "SELECT id, kind, text_content, image_path, thumbnail_path, content_hash,
                    created_at, source_device, width, height, mime_type, pinned
             FROM clipboard_items WHERE id = ?1",
        )?;
        statement
            .query_row([id], map_stored_item)
            .optional()
            .map_err(Into::into)
    }

    pub fn delete_by_id(&self, id: &str) -> Result<Option<StoredItem>, AppError> {
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        let item = {
            let mut statement = transaction.prepare(
                "SELECT id, kind, text_content, image_path, thumbnail_path, content_hash,
                        created_at, source_device, width, height, mime_type, pinned
                 FROM clipboard_items WHERE id = ?1",
            )?;
            statement.query_row([id], map_stored_item).optional()?
        };
        if item.is_some() {
            transaction.execute("DELETE FROM clipboard_items WHERE id = ?1", [id])?;
        }
        transaction.commit()?;
        Ok(item)
    }

    pub fn list(&self, query: &str) -> Result<Vec<ClipboardItem>, AppError> {
        let connection = self.open()?;
        let normalized = format!("%{}%", escape_like(&query.to_lowercase()));
        let mut statement = connection.prepare(
            "SELECT id, kind, text_content, image_path, thumbnail_path, content_hash,
                    created_at, source_device, width, height, mime_type, pinned
             FROM clipboard_items
             WHERE ?1 = '%%'
                OR lower(COALESCE(text_content, '')) LIKE ?1 ESCAPE '\\'
                OR lower(source_device) LIKE ?1 ESCAPE '\\'
             ORDER BY pinned DESC, created_at DESC
             LIMIT 50",
        )?;
        let rows = statement.query_map([normalized], map_stored_item)?;
        rows.map(|row| {
            let mut stored = row?;
            if let Some(path) = stored.thumbnail_path.as_ref() {
                match std::fs::read(path) {
                    Ok(bytes) => {
                        stored.item.preview_data_url =
                            Some(format!("data:image/png;base64,{}", STANDARD.encode(bytes)));
                    }
                    Err(error) => eprintln!("failed to read thumbnail {path}: {error}"),
                }
            }
            Ok(stored.item)
        })
        .collect()
    }

    pub fn set_pinned_by_id(&self, id: &str, pinned: bool) -> Result<(), AppError> {
        let connection = self.open()?;
        connection.execute(
            "UPDATE clipboard_items SET pinned = ?1 WHERE id = ?2",
            params![pinned, id],
        )?;
        Ok(())
    }

    pub fn set_pinned_by_hash(&self, content_hash: &str, pinned: bool) -> Result<(), AppError> {
        let connection = self.open()?;
        connection.execute(
            "UPDATE clipboard_items SET pinned = ?1 WHERE content_hash = ?2",
            params![pinned, content_hash],
        )?;
        Ok(())
    }

    pub fn update_sync_metadata_by_hash(
        &self,
        content_hash: &str,
        created_at: i64,
        source_device: &str,
        pinned: bool,
    ) -> Result<(), AppError> {
        let connection = self.open()?;
        connection.execute(
            "UPDATE clipboard_items
             SET created_at = ?1, source_device = ?2, pinned = ?3
             WHERE content_hash = ?4",
            params![created_at, source_device, pinned, content_hash],
        )?;
        Ok(())
    }

    pub fn delete_by_hash(&self, content_hash: &str) -> Result<Option<StoredItem>, AppError> {
        let item = self.find_by_hash(content_hash)?;
        if let Some(item) = &item {
            self.delete_by_id(&item.item.id)?;
        }
        Ok(item)
    }

    pub fn prune(&self, max_items: usize) -> Result<Vec<StoredItem>, AppError> {
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        let expired = {
            let mut statement = transaction.prepare(
                "SELECT id, kind, text_content, image_path, thumbnail_path, content_hash,
                        created_at, source_device, width, height, mime_type, pinned
                 FROM clipboard_items
                 ORDER BY pinned DESC, created_at DESC
                 LIMIT -1 OFFSET ?1",
            )?;
            let rows = statement.query_map([max_items as i64], map_stored_item)?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for item in &expired {
            transaction.execute("DELETE FROM clipboard_items WHERE id = ?1", [&item.item.id])?;
        }
        transaction.commit()?;
        Ok(expired)
    }
}

fn map_stored_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredItem> {
    Ok(StoredItem {
        item: ClipboardItem {
            id: row.get(0)?,
            kind: row.get(1)?,
            text_content: row.get(2)?,
            preview_data_url: None,
            content_hash: row.get(5)?,
            created_at: row.get(6)?,
            source_device: row.get(7)?,
            width: row.get(8)?,
            height: row.get(9)?,
            mime_type: row.get(10)?,
            pinned: row.get(11)?,
        },
        image_path: row.get(3)?,
        thumbnail_path: row.get(4)?,
    })
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    fn test_item<'a>(id: &'a str, hash: &'a str, text: &'a str, created_at: i64) -> NewItem<'a> {
        NewItem {
            id,
            kind: "text",
            text_content: Some(text),
            image_path: None,
            thumbnail_path: None,
            content_hash: hash,
            created_at,
            source_device: "Test Mac",
            width: None,
            height: None,
            mime_type: Some("text/plain"),
            pinned: false,
        }
    }

    #[test]
    fn migrates_searches_orders_and_deduplicates() {
        let directory = tempdir().unwrap();
        let database = Database::initialize(directory.path().join("history.db")).unwrap();
        database
            .upsert(test_item("old", "hash-a", "Alpha", 100))
            .unwrap();
        database
            .upsert(test_item("new", "hash-b", "Beta", 200))
            .unwrap();
        database
            .upsert(test_item("symbol", "hash-c", "100% ready", 150))
            .unwrap();

        let all = database.list("").unwrap();
        assert_eq!(
            all.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(),
            ["new", "symbol", "old"]
        );
        assert_eq!(database.list("alp").unwrap()[0].id, "old");
        assert_eq!(database.list("%").unwrap()[0].id, "symbol");

        let repeated = database
            .upsert(test_item("replacement", "hash-a", "Alpha", 300))
            .unwrap();
        assert_eq!(repeated.item.id, "old");
        assert_eq!(database.list("").unwrap()[0].id, "old");
        assert_eq!(database.list("").unwrap().len(), 3);

        database
            .update_sync_metadata_by_hash("hash-a", 400, "Remote Windows", true)
            .unwrap();
        let synced = database.find_by_hash("hash-a").unwrap().unwrap().item;
        assert_eq!(synced.created_at, 400);
        assert_eq!(synced.source_device, "Remote Windows");
        assert!(synced.pinned);
    }

    #[test]
    fn caps_visible_history_at_fifty() {
        let directory = tempdir().unwrap();
        let database = Database::initialize(directory.path().join("history.db")).unwrap();
        for index in 0..55 {
            database
                .upsert(test_item(
                    &format!("id-{index}"),
                    &format!("hash-{index}"),
                    &format!("item {index}"),
                    index,
                ))
                .unwrap();
        }
        let items = database.list("").unwrap();
        assert_eq!(items.len(), 50);
        assert_eq!(items[0].id, "id-54");
        assert_eq!(items[49].id, "id-5");
    }

    #[test]
    fn prunes_storage_to_eighty_while_prioritizing_pinned_items() {
        let directory = tempdir().unwrap();
        let database = Database::initialize(directory.path().join("history.db")).unwrap();
        for index in 0..85 {
            database
                .upsert(test_item(
                    &format!("id-{index}"),
                    &format!("hash-{index}"),
                    &format!("item {index}"),
                    index,
                ))
                .unwrap();
        }
        database.set_pinned_by_id("id-0", true).unwrap();

        let expired = database.prune(80).unwrap();

        assert_eq!(expired.len(), 5);
        assert!(database.find_by_id("id-0").unwrap().is_some());
        for index in 1..=5 {
            assert!(
                database
                    .find_by_id(&format!("id-{index}"))
                    .unwrap()
                    .is_none()
            );
        }
        assert!(database.find_by_id("id-6").unwrap().is_some());
    }

    #[test]
    fn deletes_only_the_requested_item() {
        let directory = tempdir().unwrap();
        let database = Database::initialize(directory.path().join("history.db")).unwrap();
        database
            .upsert(test_item("keep", "hash-keep", "Keep", 100))
            .unwrap();
        database
            .upsert(test_item("delete", "hash-delete", "Delete", 200))
            .unwrap();

        let deleted = database.delete_by_id("delete").unwrap().unwrap();
        assert_eq!(deleted.item.id, "delete");
        assert!(database.find_by_id("delete").unwrap().is_none());
        assert_eq!(database.list("").unwrap()[0].id, "keep");
        assert!(database.delete_by_id("missing").unwrap().is_none());
    }
}
