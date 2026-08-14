# Red Music: app-only + persistent session

- The Capacitor app uses the bundled `public/` UI instead of `server.url`.
- Render no longer serves the web UI.
- Backend routes require `X-Red-Music-App: android`.
- Authentication accepts the existing HTTP-only cookie or a bearer token.
- Login/register responses return the JWT so the installed app can retain its session across updates.
- The GitHub Actions release workflow runs manually or for version tags `v*.*.*`, not on every push to `main`.

The backend URL is still technically discoverable from the APK because the APK must contact the API. This is app-level access control, not an impossible-to-extract secret.
