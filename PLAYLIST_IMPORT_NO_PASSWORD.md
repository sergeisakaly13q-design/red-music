# Red Music — public playlist import without passwords

Public playlist imports from Spotify, SoundCloud, YouTube Music, Apple Music and Yandex Music can now be saved without entering a Red Music password. Logged-in users save to their normal account library; users without a valid Red Music session receive a private device-scoped guest identity through an HttpOnly cookie.

Tracks that do not exist in the Red Music catalog are still saved as playlist metadata (title, artist, source and external URL) and are not rejected merely because they are unmatched.

This does not bypass private playlists, provider access controls, or protected media. Only public playlist pages/metadata are imported.

Yandex Music public playlist URLs in the form `https://music.yandex.ru/users/<user>/playlists/<id>` are imported through the public playlist metadata endpoint without asking for a Yandex password.
