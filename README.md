# UniVote backend

NestJS REST API and Prisma database for UniVote. The API is served under `/api/v1` on port `3001` by default.

## Local setup

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env`. Configure `DATABASE_URL` with the PostgreSQL connection string, generate an `AUTH_TOKEN_SECRET` with at least 32 characters, and set a random `ADMIN_BOOTSTRAP_KEY`.
3. Generate the Prisma client: `npm run prisma:generate`.
4. Check the current database migration state with `npx prisma migrate status`. Apply pending migrations with `npm run db:deploy` only after confirming the target database is correct. The checked-in migration history is incremental and expects the existing UniVote schema; it is not a blank-database initialization script.
5. Start the API with `npm run start:dev`; check `http://localhost:3001/api/v1/health`.
6. In a separate terminal, configure and start the frontend as described in `../campusvote/README.md`. The default frontend origin is `http://localhost:3000`; set `CORS_ORIGINS` to the exact frontend origins when they differ.

Never commit `.env` files or share database URLs and signing keys. The deployment environment must provide the same settings through its secret manager.

## Initial administrator

Set `ADMIN_BOOTSTRAP_KEY`, `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`, and optionally `BOOTSTRAP_ADMIN_NAME` in the backend environment before first setup. After the database schema is current, call `POST /api/v1/auth/bootstrap-admin` with `{"setupKey":"<ADMIN_BOOTSTRAP_KEY>"}`. The administrator email and password are read from the backend environment, not the request. Bootstrap refuses to create another administrator once one exists. Remove the bootstrap key and bootstrap password from the runtime environment after setup, then sign in with the configured email and password.

## API areas

- `GET /api/v1/health`: API health check.
- `/api/v1/auth`: sign-in, student eligibility and sign-up, OTP verification, current account, logout, and one-time administrator bootstrap.
- `/api/v1/registry`: registry search and registrar imports.
- `/api/v1/elections`: elections, nominations, encrypted ballots, participation, results, and voter roll.
- `/api/v1/users`: administrator account management and students' own registry record.
- `/api/v1/settings` and `/api/v1/audit`: system settings and audit records.

Protected endpoints require `Authorization: Bearer <access-token>`. OTP codes are returned by the API only in development; production SMS/email delivery is not configured. Ballots are client-encrypted and stored separately from voter participation. Verify the complete election, key-management, deployment, and incident-response procedures before using the system for a real election.

## Scripts

- `npm run build`: compile the API.
- `npm run test -- --runInBand`: run backend unit tests.
- `npm run prisma:validate`: validate the Prisma schema.
- `npm run db:deploy`: apply checked-in migrations to the configured database.
- `npm run start:dev`: start the API in watch mode.
