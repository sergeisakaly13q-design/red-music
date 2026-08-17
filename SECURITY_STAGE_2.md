# SECURITY_STAGE_2

## 1. Account security
- Production now requires `JWT_SECRET` with at least 32 characters.
- JWTs use issuer/audience validation and a 30-day expiration.
- Authentication cookies remain HttpOnly and use secure/same-site settings.
- A per-account `session_version` is embedded in tokens.
- Logout increments `session_version`, immediately revoking previously issued sessions.
- Disabling a user's password also increments `session_version`, revoking existing sessions.
- Existing bcrypt hashes are transparently upgraded to cost 12 after a successful login.
- Existing databases receive `session_version` through a safe startup migration.

## 2. SQL injection protection
- The server's database access was audited for user-controlled SQL construction.
- User-controlled values in application SQL are passed through better-sqlite3 parameter placeholders (`?`), not string concatenation.
- The only interpolated SQL identifiers are internal fixed migration table names, never request data.
- API validation additionally rejects prototype-pollution keys before route logic.

## 3. API validation
- Added `middleware/apiValidation.js`.
- Rejects prototype-pollution keys (`__proto__`, `prototype`, `constructor`).
- Limits object key count, array size, nesting depth and very large strings.
- Validates numeric route/query identifiers such as `id`, `userId`, `trackId` and `roleId`.
- Rejects oversized query values.
- Existing route-specific validation remains in place.

## Important deployment requirement
Set `JWT_SECRET` in the production environment. Do not put the real secret in `.env`, GitHub source, JavaScript, or the frontend.
