# UniVote backend

Standalone NestJS REST API for UniVote. It is intentionally not connected to the frontend yet; frontend integration will be a later step.

## Local setup

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env` and set `DATABASE_URL` to your Neon PostgreSQL URL. This repository does not contain database credentials.
3. Set a random `AUTH_TOKEN_SECRET` (at least 32 characters) and `ADMIN_BOOTSTRAP_KEY`.
4. Generate Prisma Client with `npm run prisma:generate`.
5. Create and apply the first migration after configuring Neon: `npx prisma migrate dev --name init`. Later deploys use `npm run db:deploy`.
6. Start locally with `npm run start:dev`; API routes use `/api/v1` and default to port `3001`.

`npm run prisma:validate` checks the schema and `npm run build` compiles the API. Database commands need a working `DATABASE_URL`.

## Initial administrator

After the database schema is deployed, make a one-time `POST /api/v1/auth/bootstrap-admin` request with JSON `{ "key": "...", "name": "...", "email": "...", "password": "..." }`. The key must match `ADMIN_BOOTSTRAP_KEY`. Bootstrap is disabled once a system administrator exists. Keep this key private and remove it from the runtime environment after bootstrap.

## API areas

All routes are prefixed with `/api/v1`. Protected endpoints use `Authorization: Bearer <token>`.

- `GET /health`: process health.
- `/auth`: login, student signup, OTP verification, current account, logout, and one-time admin bootstrap.
- `/registry`: browse records and import registrar rows in merge or replace mode.
- `/elections`: browse elections and contests, create/manage elections, nominate candidates, review nominations, cast encrypted ballots, and query participation/voter roll.
- `/users`: administer student/staff accounts, credentials, status, and account unlocks.
- `/settings`: academic-year/application settings and election-officer permissions.
- `/audit`: activity log and election audit history.

Use JSON requests for registry import (`rows` plus `mode` and optional `sourceFilename`). The importer maps source workbook headers to the backend fields; student bulk import templates are a frontend deliverable for the later integration phase.

## Current integration boundaries

- No frontend code or frontend API client is changed here.
- OTP codes are returned by the API in development for manual flows. A production SMS/email delivery provider is not configured.
- Ballots are accepted as client-encrypted opaque payloads; the server records participation separately and does not store selections in plaintext.
- Configure CORS through comma-separated `CORS_ORIGINS` when the frontend is integrated.
