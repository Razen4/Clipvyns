# Clipvyn agent instructions

These instructions apply to the entire repository.

## Version updates

- Update the application version whenever a completed user-facing change is prepared for delivery.
- Use a semantic version in `MAJOR.MINOR.PATCH` format. Use a patch increment by default unless the user explicitly requests a minor, major, or prerelease version.
- Never edit version fields independently. From the repository root, run:

  ```sh
  npm run version:set -- <new-version>
  ```

  This command updates `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, the Clipvyn package entry in `src-tauri/Cargo.lock`, and the current-version/release examples in `README.md`.

- Verify that every version field matches:

  ```sh
  npm run version:check -- <new-version>
  ```

- Run `npm run build` after changing the version. For Rust or desktop changes, also run:

  ```sh
  cargo test --manifest-path src-tauri/Cargo.toml
  ```

- Report the new version and verification results in the final response.
- Do not create commits, tags, releases, build distributable release artifacts, upload APKs, or push to a remote unless the user explicitly confirms that they want the release to be created.
- A request to change or update the application does not by itself authorize release creation or publication. After the implementation, version update, and required checks are complete, ask the user whether they want to create and publish the GitHub Release and APK. Wait for an affirmative response before continuing with any release-delivery action.
- When authorized to release, the tag must be exactly `v<new-version>` and must match all version files before it is pushed.

## Release delivery

- After the user explicitly confirms release creation, update both of these delivery channels:
  1. Create or update the GitHub Release for `v<new-version>`, including the desktop installers and release notes.
  2. Build the Android Companion APK for the same version and upload it to the APK Google Drive folder: `https://drive.google.com/drive/folders/1n0X_nmqFZ_INENXt9USzFI3VNiiZC92I`.
- Name the Android artifact `Clipvyn-Companion-<new-version>-arm64.apk` unless the target architecture changes.
- Ensure the application version, Git tag, GitHub Release, desktop artifacts, and APK version all match before reporting completion.
- Verify that the GitHub Release assets and the uploaded APK can be found and downloaded. Report their links in the final response.

## Working tree safety

- Preserve unrelated and pre-existing changes. Do not discard or overwrite another contributor's work.
- Keep generated build output out of commits unless it is already tracked and intentionally required.

## License and ownership

- This project is copyright Razen4 and distributed under the repository's `LICENSE` file.
- Preserve the `LICENSE` file and the Razen4 ownership notice in all copies, packages, and releases.
- Do not change the license terms or copyright owner unless the user explicitly requests it.
