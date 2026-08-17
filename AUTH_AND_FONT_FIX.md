# Red Music UI Fix

- Fixed authentication form interaction by giving the auth layer a top stacking context and explicit pointer/keyboard interaction.
- Removed stale loading overlay when authentication is shown.
- API requests now consistently send credentials for the Render API.
- Added the project's GitHub Pages origin to CORS/CSRF allowlists and support for FRONTEND_ORIGIN.
- Unified the application font to a soft Segoe UI Variable/Segoe UI system stack across UI components, including premium screens and code-like labels.
