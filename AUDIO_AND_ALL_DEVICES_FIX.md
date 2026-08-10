# Red Music 4.4.0 — готовое исправление

Исправлено:
- `/music/<filename>` ищет аудиофайл не только в `public/music`, но и в типичных папках репозитория.
- Добавлена поддержка HTTP Range Requests, нужная Android WebView.
- Добавлены `HEAD`, `Content-Length`, `Content-Range`, audio MIME.
- GitHub Actions использует `lfs: true` для больших файлов Git LFS.
- Убран npm cache, из-за которого workflow требовал package-lock.json.
- Добавлена проверка `/api/music/public-health`.
- Добавлена проверка одного трека `/api/music/check/<filename>`.
- APK использует HTTPS Render.

После деплоя Render проверь:
`https://red-music.onrender.com/api/music/public-health`

Если `trackFiles: 0`, реальные MP3 не попали в Render deployment. Код не может
создать отсутствующий файл. Если `trackFiles > 0`, проверь конкретный файл:
`https://red-music.onrender.com/api/music/check/xxxtentacion-numb.mp3`
