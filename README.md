# Clipvyn

A compact macOS and Windows clipboard-history application built with Tauri 2, Vue 3, TypeScript, Pinia, Tailwind CSS, Rust, and SQLite.

Current version: **0.0.24**

## Current implementation

Local clipboard history includes:

- native, system-wide polling of text and RGBA image clipboard content in Rust;
- durable SQLite history with a checked-in migration and WAL journaling;
- full-resolution local PNG storage plus bounded 320×180 thumbnails;
- SHA-256 content deduplication with stable item IDs;
- native text and image restoration followed by automatic paste into the previously focused application;
- newest-first history retaining 80 items with native SQLite search limited to 50 visible results;
- per-item deletion with removal of associated local image files;
- a compact keyboard-accessible Vue/Pinia interface with loading, empty, and error states.

The web app keeps its latest 80 clipboard items in browser `localStorage` and
shows up to 50 matching items, so
local history, paste, pin, delete, and copy remain available without signing in.
When signed in to the same Firebase account, text and PNG clipboard images sync
between the web app, macOS, and Windows. PNG data is split into bounded
Firestore documents, so no Cloudflare service or Firebase Storage bucket is
required. Firestore, SQLite, and associated image data are pruned beyond the
80-item retention limit. Settings can enable or disable launch at login on macOS and Windows.
Tray/menu-bar behavior, private mode, and pause controls are not implemented.

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

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw "$env:USERPROFILE\.tauri\clipboard-sharings.key"
npm run build:windows
```

The installers are written to `src-tauri/target/release/bundle/nsis/` and
`src-tauri/target/release/bundle/msi/`. If `TAURI_SIGNING_PRIVATE_KEY` is not
set, the installers may be produced but updater signature generation will fail.

Build macOS bundles (`.app` and `.dmg`) on a Mac:

```sh
npm ci
npm run build:macos
```

The macOS bundles are written to `src-tauri/target/release/bundle/macos/` and
`src-tauri/target/release/bundle/dmg/`. A Mac or macOS CI runner is required;
macOS bundles cannot be produced locally on Windows.

### Android companion

The Android companion signs in to the same Firebase account as the desktop
apps. It synchronizes text clipboard items, copies a selected item into the
Android system clipboard, and appears in Android's **Share** menu for plain
text. Opening or returning to the companion imports new clipboard text and
sends it to signed-in macOS and Windows devices.

Android 10 and newer do not allow an ordinary background app to continuously
read the clipboard. The companion therefore imports clipboard text only while
it is visible; sharing text directly to Clipvyn is the most reliable workflow.
Image history remains visible but native image copy/share is not included in
this first companion release.

After installing JDK 17, the Android SDK Platform/Build Tools, NDK, and Android
Rust targets, build the arm64 APK with:

```sh
npm run build:android
```

The APK is written beneath
`src-tauri/gen/android/app/build/outputs/apk/universal/release/`. A distributable
release must be signed with the same protected Android signing key for every
future update.

The Android companion checks the latest GitHub Release when it starts. When a
new arm64 APK is available, **Settings > App update > Download & install**
downloads it into the app cache and opens the Android installer. Android still
requires the user to approve the installation and may request **Install unknown
apps** permission the first time. Every update must keep the same application
ID and Android signing key as the installed APK.

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

Update and verify all application version fields from any development machine:

```sh
npm run version:set -- 0.0.24
npm run version:check -- 0.0.24
npm run build
```

Only when a release is ready and pushing has been explicitly authorized:

```sh
git add .
git commit -m "chore: release v0.0.24"
git tag v0.0.24
git push origin main v0.0.24
```

The workflow rejects a tag whose version does not match `package.json`,
`package-lock.json`, `src-tauri/tauri.conf.json`, `Cargo.toml`, and `Cargo.lock`.
Version `0.0.22` is the Android updater bootstrap release and must be installed manually;
clients on that release can install later releases from inside the app.

The local database and image directory are created beneath Tauri's per-user app-data directory. Typical locations are:

- macOS: `~/Library/Application Support/com.razencdev.clipboard-sharings/`
- Windows: `%APPDATA%\\com.razencdev.clipboard-sharings\\`

The Tauri desktop webview does not use the browser Clipboard API; it calls the
allowlisted Rust commands and listens for native clipboard change notifications.
The standalone web app uses the browser Clipboard API only after a direct user
action and stores its local history under `clipvyn-web-clipboard-v1` in
`localStorage`.

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

Copyright (c) 2026 Razen4. All rights reserved. See [`LICENSE`](LICENSE) for the complete proprietary terms.

## Roadmap boundaries

- Phase 2: tray/menu bar, private mode, pause controls, and native-paste permissions.
- Durable sync queue, retry/backoff, pause/private modes, cleanup, and encryption lifecycle.
- macOS/Windows integration matrices, platform packaging, and release documentation.
