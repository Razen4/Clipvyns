# Deploy to Vercel

This repository now serves a browser dashboard when it is built outside Tauri.
The desktop build still uses the native Tauri interface.

1. Import this repository into Vercel.
2. Select **Vite** (the included `vercel.json` already supplies the build and output settings).
3. Add these environment variables to **Production** and **Preview**:
   - `VITE_FIREBASE_API_KEY`
   - `VITE_FIREBASE_AUTH_DOMAIN`
   - `VITE_FIREBASE_PROJECT_ID`
   - `VITE_FIREBASE_STORAGE_BUCKET`
   - `VITE_FIREBASE_MESSAGING_SENDER_ID`
   - `VITE_FIREBASE_APP_ID`
4. In Firebase Authentication, add the Vercel production and preview domains to **Authorized domains**.
5. Deploy.

The web dashboard is read-only for synced items, except that text items can be copied with the browser clipboard permission. System-wide clipboard capture remains a desktop-app feature.

## Install as an app

The Vercel deployment is a PWA. On iPhone/iPad, open it in Safari and choose **Share → Add to Home Screen**. On Android and supported desktop browsers, use the browser's **Install app** prompt. The app shell remains available offline; Firebase sync and clipboard actions need a connection and browser permission.

Do not put Filebase access or secret keys in Vercel `VITE_` variables. If you later move image bytes from Firestore chunks to Filebase, keep Filebase credentials in a Vercel Function and issue short-lived signed URLs only after verifying the Firebase ID token.
