# Red Music 4.3.0

Исправлено:

- APK всегда получает музыку с `https://red-music.onrender.com`, а не относительно адреса Android WebView.
- Убран `crossOrigin` у HTML Audio.
- Добавлен повторный запуск `audio.play()` для Android WebView.
- Улучшена диагностика ошибок аудио.
- `/api/music/:id/stream` теперь поддерживает HTTP Range Requests.
- GitHub Actions больше не использует `cache: gradle` до создания Android-проекта. Это исправляет ошибку `No file ... matched to **/*.gradle*`.
- Добавлена диагностика `https://red-music.onrender.com/api/music/public-health`.

## ВАЖНО

В исходном загруженном ZIP **нет ни одного MP3/WAV/OGG/M4A/FLAC файла**.

В нём есть каталог `public/music/` и список треков в `public/index.html`, но самих аудиофайлов нет.

Поэтому код теперь подготовлен для всех устройств, но физические файлы музыки всё равно должны быть на сервере.

Например:

`public/music/xxxtentacion-save-me.mp3`

`public/music/xxxtentacion-numb.mp3`

После добавления файлов в `public/music/` и push в GitHub Render раздаёт их всем пользователям:

`https://red-music.onrender.com/music/ИМЯ-ФАЙЛА.mp3`

Проверка:

`https://red-music.onrender.com/health`

`https://red-music.onrender.com/api/music/public-health`

На втором адресе `trackFiles` должен быть больше 0.

Если конкретный MP3 даёт 404, значит файла нет в деплое.
