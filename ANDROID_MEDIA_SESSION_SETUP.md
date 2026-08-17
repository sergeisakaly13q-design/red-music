# Red Music Android MediaSession

Этот ZIP добавляет нативную Android MediaSession поверх существующего HTML-аудиоплеера.

## Сборка
1. `npm install`
2. `npx cap sync android`
3. `npx cap open android`
4. Соберите APK в Android Studio.

Системная шторка получает название, исполнителя, обложку, play/pause, previous/next и seekbar.
Нативная сессия отправляет действия обратно в существующий HTML-плеер, поэтому не создаётся второй источник звука.
