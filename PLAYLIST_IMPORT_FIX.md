# Playlist import fix

## What changed

- Playlist preview can collect up to 5,000 tracks instead of stopping at 500.
- Added broader embedded JSON extraction for dynamic provider pages.
- Added YouTube Music continuation-token pagination using the public page's exposed continuation data.
- Added paginated Yandex Music requests with deduplication.
- Imported tracks that are not present in the Red Music catalog are still saved as external playlist items.
- External imported items keep their source URL instead of becoming an empty/missing playlist entry.
- `/api/playlists/import/save` now reports total received, saved, matched and external counts.
- `/api/playlists/mine` continues returning all imported playlist positions in their original order.
- Frontend distinguishes external imported tracks and can open their original source.
- JavaScript syntax was checked with Node.js.

## Important limitation

A playlist URL does not grant Red Music permission to download audio from Spotify, YouTube Music, Apple Music, SoundCloud or Yandex Music. External items therefore retain their source metadata and source URL. Only audio that Red Music legitimately has access to can be played directly inside the Red Music player or downloaded for VIP offline use.
