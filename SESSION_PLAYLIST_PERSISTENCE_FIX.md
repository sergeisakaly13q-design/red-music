# Red Music — session and playlist persistence fix

This update prevents the client from treating a sleeping/restarting Render API or a temporarily missing SQLite database as a reason to erase local playlists or log the user out.

## GitHub

Replace:
- `public/index.html`

No other project files are required for this client-side fix.

## Important server-side limitation

Render's ephemeral filesystem can still erase the SQLite database after a redeploy/restart. The client now keeps the local account/session and local imported playlists instead of wiping them, but permanent server-side persistence requires an external persistent database such as Firebase/Firestore or a Render Persistent Disk.

The planned long-term architecture is Firebase/Firestore for accounts, playlists and app data, plus Cloudflare R2 for music and media files.
