# SECURITY STAGE 3

Implemented:
1. XSS hardening: server-side text cleanup for profile/music metadata plus CSP and safe security headers.
2. CSRF protection: origin/referer validation for state-changing API requests using cookie authentication.
3. Security headers: CSP, HSTS in production, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, frame-ancestors/X-Frame-Options.

Important: the frontend already uses an `esc()` HTML-escaping helper in dynamic UI rendering. CSP intentionally allows the existing inline application code so the current Red Music UI does not break. This is stronger defense-in-depth, not a substitute for escaping untrusted values.
