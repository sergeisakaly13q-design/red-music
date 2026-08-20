# Red Music — автоматический защищённый backup SQLite

Система делает согласованный snapshot `storage/data/red-music.db`, шифрует его AES-256-GCM и отправляет зашифрованный файл в Telegram. Сам `red-music.db` и расшифрованная копия наружу не отправляются.

## Render variables

Добавить:

- `BACKUP_SECRET` — случайная строка минимум 32 символа. Это пароль доступа к backup endpoint.
- `BACKUP_ENCRYPTION_KEY` — ровно 64 hex-символа (32 байта). Потеря этого ключа означает, что backup нельзя расшифровать.
- `BACKUP_TELEGRAM_CHAT_ID` — ID приватного Telegram-чата/канала, куда бот должен отправлять backup. Если не задан, система использует `TELEGRAM_ADMIN_CHAT_ID`, затем `OWNER_TELEGRAM_ID`.

Уже существующий `TELEGRAM_BOT_TOKEN` должен иметь право отправлять документы в этот чат.

## GitHub Actions secrets

В GitHub → Settings → Secrets and variables → Actions добавить:

- `RED_MUSIC_URL` = полный URL Red Music, например `https://red-music.onrender.com`
- `BACKUP_SECRET` = тот же `BACKUP_SECRET`, что в Render.

Workflow `.github/workflows/database-backup.yml` запускается ежедневно в 03:17 UTC и также может быть запущен вручную через **Run workflow**.

## Важно

Не хранить `BACKUP_ENCRYPTION_KEY` в GitHub, коде или ZIP. Сохранить его отдельно у владельца проекта. Если ключ потерян, зашифрованные backup-файлы восстановить нельзя.
