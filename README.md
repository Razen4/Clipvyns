# Clipvyn

A compact macOS and Windows clipboard-history application built with Tauri 2, Vue 3, TypeScript, Pinia, Tailwind CSS, Rust, and SQLite.

## Current implementation

Local clipboard history includes:

- native, system-wide polling of text and RGBA image clipboard content in Rust;
- durable SQLite history with a checked-in migration and WAL journaling;
- full-resolution local PNG storage plus bounded 320×180 thumbnails;
- SHA-256 content deduplication with stable item IDs;
- native text and image restoration followed by automatic paste into the previously focused application;
- newest-first history and native SQLite search, limited to 50 visible results;
- per-item deletion with removal of associated local image files;
- a compact keyboard-accessible Vue/Pinia interface with loading, empty, and error states.

When signed in to the same Firebase account, text and PNG clipboard images sync between macOS and Windows. PNG data is split into bounded Firestore documents so no Cloudflare service or Firebase Storage bucket is required. Settings can enable or disable launch at login on macOS and Windows. Tray/menu-bar behavior, private mode, and pause controls are not implemented.

## Prerequisites

- Node.js 24 or another version supported by Vite 8
- Rust 1.90 or newer
- macOS development tools (macOS), or Visual Studio C++ Build Tools and WebView2 (Windows 11)

Install and run:

```sh
npm install
npm run tauri dev
```

Build Windows installers (`.exe` and `.msi`) from a Visual Studio Developer PowerShell:

```sh
npm run build:windows
```

The installers are written to `src-tauri/target/release/bundle/nsis/` and
`src-tauri/target/release/bundle/msi/`.

Build macOS bundles (`.app` and `.dmg`) on a Mac:

```sh
npm ci
npm run build:macos
```

The macOS bundles are written to `src-tauri/target/release/bundle/macos/` and
`src-tauri/target/release/bundle/dmg/`. A Mac or macOS CI runner is required;
macOS bundles cannot be produced locally on Windows.

To build Windows x64 plus macOS Apple Silicon and Intel in one GitHub Actions
run, add these repository Actions secrets, then run the **Build desktop
installers** workflow:

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`
- `TAURI_SIGNING_PRIVATE_KEY`

With GitHub CLI installed and authenticated:

```sh
gh workflow run build-desktop.yml
```

Manual workflow runs store the completed installers in the run's **Artifacts**
section. Pushing a version tag creates a public GitHub Release containing the
installers, signed updater bundles, and `latest.json` used by installed clients.

## Releases and automatic updates

The desktop app checks for a signed update when it starts. Users can also open
**Settings** and select **Check for updates**. When a release is available, the
app downloads it with progress feedback, verifies its updater signature,
installs it, and restarts.

The updater signing private key is release infrastructure. Keep it outside the
repository and back it up securely. This project's local key is stored at
`%USERPROFILE%\.tauri\clipboard-sharings.key`; only its public key is checked
into `src-tauri/tauri.conf.json`. Store the complete private-key text in the
GitHub Actions secret named `TAURI_SIGNING_PRIVATE_KEY`.

With GitHub CLI authenticated, set that secret once from PowerShell:

```powershell
Get-Content -Raw "$env:USERPROFILE\.tauri\clipboard-sharings.key" |
  gh secret set TAURI_SIGNING_PRIVATE_KEY
```

Create a release from any development machine with:

```sh
npm run version:set -- 0.1.6
git add .
git commit -m "chore: release v0.1.6"
git tag v0.1.6
git push origin main v0.1.6
```

The workflow rejects a tag whose version does not match `package.json`,
`package-lock.json`, `src-tauri/tauri.conf.json`, `Cargo.toml`, and `Cargo.lock`.
Version `0.1.5` is the updater bootstrap release and must be installed manually;
clients on that release can install later releases from inside the app.

The local database and image directory are created beneath Tauri's per-user app-data directory. Typical locations are:

- macOS: `~/Library/Application Support/com.razencdev.clipboard-sharings/`
- Windows: `%APPDATA%\\com.razencdev.clipboard-sharings\\`

No browser Clipboard API is used. The webview only calls the allowlisted Rust commands and listens for change notifications.

## Phase 1 test instructions

Run all automated checks:

```sh
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets
```

On an interactive desktop, native text-and-image restoration can also be smoke-tested with:

```sh
cargo test --manifest-path src-tauri/Cargo.toml restores_text_and_image_to_native_clipboard -- --ignored --test-threads=1
```

Manual clipboard smoke test:

1. Start `npm run tauri dev`.
2. Copy text in an application other than Clipvyn and confirm it appears at the top within about one second.
3. Copy a screenshot or image and confirm its thumbnail and dimensions appear.
4. Enter a distinctive substring in Search and confirm unrelated rows disappear.
5. Select text and image rows in turn; the Clipboard window should minimize and paste into the previous application automatically.
6. Use Up/Down and Enter to navigate and paste without a mouse.
7. Re-copy an earlier value and confirm its existing row moves to the top instead of creating a duplicate.

On first automatic paste, macOS may request Accessibility permission. Enable Clipvyn under **System Settings > Privacy & Security > Accessibility**, then reopen the application. Clipboard capture and ordinary restore do not require this permission; it is used only to synthesize Command+V.

Windows clipboard behavior and packaging must be validated on a Windows 11 build host. Intel macOS compilation requires the `x86_64-apple-darwin` Rust target and an Intel host or suitable cross-build environment; it is not claimed by the Apple Silicon-only checks below.

## Data model

Migration [`src-tauri/migrations/0001_clipboard_items.sql`](src-tauri/migrations/0001_clipboard_items.sql) creates a local `clipboard_items` table. Image rows point to private per-user local files; image bytes are not stored in SQLite. Re-copying identical content updates its timestamp while preserving its stable ID.

## Firebase setup

Copy `.env.example` to `.env` and supply the Firebase web-app values. `.env` files and local databases are ignored by Git.

Enable Email/Password Authentication and Cloud Firestore for the Firebase project. Log in to the Firebase CLI and deploy the Firestore rules before using sync:

```sh
npx firebase-tools login
npx firebase-tools deploy --only firestore:rules --project YOUR_PROJECT_ID
```

Image chunks are saved privately under each Firebase user; the included rules only allow the signed-in owner to read or write them. Firebase configuration values identify the Firebase web app and are not server secrets. Do not put S3/Filebase secret keys in any `VITE_` variable because Vite embeds exposed variables in the desktop bundle.

## Security and configuration

The Tauri capability grants core commands plus the explicitly needed global-shortcut and autostart plugin commands; clipboard and filesystem access occur inside the Rust process rather than through frontend plugins.

## License

Copyright (c) 2026 Razen4. All rights reserved. See [`LICENSE`](LICENSE) for the complete terms.

## Roadmap boundaries

- Phase 2: tray/menu bar, private mode, pause controls, and native-paste permissions.
- Durable sync queue, retry/backoff, pause/private modes, cleanup, and encryption lifecycle.
- macOS/Windows integration matrices, platform packaging, and release documentation.
# Clipvyn
