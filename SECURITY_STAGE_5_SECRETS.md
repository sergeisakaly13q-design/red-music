# Red Music Security: Secrets & Environment Protection

This stage protects application secrets and prevents production startup with missing or known placeholder credentials.

## Required production secrets

- `JWT_SECRET`: random, at least 32 characters.
- `MASTER_PASSWORD`: random, at least 12 characters.
- `MASTER_USERNAME`: non-empty.

Real values must be configured through the deployment provider's environment/secrets settings and must never be committed to GitHub.

## Repository protection

`.gitignore` ignores `.env` and `.env.*` while explicitly allowing `.env.example`.

## Fail-closed behavior

Production startup stops if required secrets are missing, too short, or match known unsafe placeholder values.

No secret value is printed to logs.

## Render

`render.yaml` generates `JWT_SECRET` and `MASTER_PASSWORD` as deployment secrets. Review the generated values in Render's environment settings. Do not copy them into source files.

## Local development

Copy `.env.example` to `.env` and replace the placeholders with real random values. `.env` is ignored by Git.
