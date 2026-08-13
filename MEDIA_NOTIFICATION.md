# Red Music media notification

The player now uses the Android/WebView Media Session API.

When a supported Android WebView/browser allows background media controls,
an actively playing Red Music track exposes:
- track title and artist;
- Red Music artwork;
- play/pause;
- previous/next;
- seek backward/forward;
- playback position;
- lock-screen/background playback state.

The implementation is in `public/index.html`. It does not create a fake
HTML notification inside the app UI.
