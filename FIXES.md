# Red Music 4.2.1 fixes

Fixed:
- Android/WebView API requests use https://red-music.onrender.com instead of relying on relative localhost paths.
- API requests include credentials for server authentication.
- Added CORS handling for Capacitor/Android origins.
- Production auth cookie supports cross-origin Capacitor requests.
- Capacitor is pinned to the Red Music Render URL.
- GitHub Actions checks /health before building the APK.
- GitHub Actions keeps the Kotlin duplicate-class workaround.
- APK artifact path is explicit.

Important:
- The uploaded project contains public/music/README.txt but no actual MP3 files.
  The frontend references /music/*.mp3. To distribute those tracks from this project,
  the actual audio files must be present in public/music or uploaded to the server.


## OWNER-only Admin panel
- Admin navigation is hidden with the HTML `hidden` attribute for non-OWNER users.
- The Admin screen itself is hidden for non-OWNER users.
- Navigation checks OWNER access before opening the Admin screen.
- Existing server-side OWNER protection for `/api/admin/*` routes remains unchanged.
