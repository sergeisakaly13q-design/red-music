# Red Music — Security Stage 1

Implemented the first three free security layers:

## 1. Rate limiting
- Global `/api` limit: 600 requests/minute per IP and authenticated account.
- `/api/auth/login`: 12 attempts/15 minutes.
- `/api/auth/register`: 5 registrations/15 minutes per IP.
- Auth sync endpoints: 20/10 minutes.
- Promo activation: 10/10 minutes.
- Music uploads: 10/15 minutes.
- Favorite/unfavorite interactions: 60/minute.
- Sensitive limits return HTTP 429 and `Retry-After`.
- The global limit is intentionally high so Media3/ExoPlayer range requests are not broken.

## 2. Brute-force protection
- Failed login attempts are tracked by IP, account and IP+account.
- After 5 failures for an account, temporary blocking starts.
- IP-wide blocking is more tolerant and starts after 20 failures.
- Progressive delays are applied after failed attempts.
- Block duration increases up to 30 minutes.
- Successful authentication clears the account-specific counters without clearing the IP-wide defense.
- Protection is dependency-free and uses temporary in-memory state, so a server restart clears temporary counters.

## 3. Server-side authorization
- Roles are read from SQLite on protected role checks.
- Client-provided role data is never trusted for authorization.
- `OWNER` is restricted to server-side account ID 1.
- A stale/forged OWNER role on another account is rejected.
- Banned accounts cannot pass `requireRole`.
- Existing OWNER/CO-CREATOR/USER/VIP route permissions remain in place.

## Files changed
- `server.js`
- `middleware/auth.js`
- `middleware/rateLimit.js` (new)
- `middleware/bruteForce.js` (new)
- `routes/auth.js`
- `routes/music.js`

No paid service or API was added.
