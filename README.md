# OneLead Server

Express + MySQL/MariaDB API for the OneLead lead-management app (frontend: `../OFFICE`).
Full endpoint reference: [docs/API.md](docs/API.md).

## Setup

```bash
cp .env.example .env      # fill in DB_* and WhatsApp OTP settings
npm install
npm run setup             # fresh database only: base tables + all migrations
npm run dev               # http://localhost:5823
```

The server refuses to start if the database is missing migrations, so it can never run new code
against an old schema.

## Database changes — backup first, always

```bash
npm run backup-db             # full dump → backups/<db>-<timestamp>.sql (+ .json manifest)
npm run migrate -- --status   # read-only: list applied / pending migrations
npm run migrate               # apply pending migrations
```

- **Backups** are verified while they are written: every table's dumped row count is checked
  against the live table, and a sha256 is stored in the manifest. `backups/` is git-ignored because
  it contains customer data — keep copies somewhere safe.
- **Restore** (destructive for the target DB):
  `npm run restore-db -- backups/<file>.sql --target <DB_NAME> --yes`.
  The target must equal `DB_NAME` in `.env`, and the file must match its manifest checksum.
- **Migrations** live in `src/migrations/index.js`. They are additive (new tables, columns, indexes
  and enum values only), idempotent (safe to re-run after a failure) and recorded in
  `schema_migrations`. Never edit a migration that has already run in production — append a new one.
  Write them with `src/migrations/helpers.js` so they work on both MySQL 8 and MariaDB.

## Data-safety rules in the code

- Leads are never hard-deleted: "delete" archives (`archived_at`), and admins can restore.
- Merging duplicates moves reminders, appointments, activities, history and tags to the kept lead,
  fills only its empty fields, and archives the duplicates with `merged_into`.
- Every create/update/assign/archive/merge/import/export is written to `audit_logs`.

## Structure

```
server.js                 app, routes, error handler, schema check
src/config/db.js          connection pool (IST session time zone)
src/lib/http.js           HttpError, asyncHandler, validate, pagination
src/middleware/auth.js    session auth + role guard
src/services/             leads (filters, scoring, duplicates), assignment (round-robin), audit, settings
src/routes/               auth, users, products, leads, activities, reminders, appointments,
                          tasks, reports, tags, settings, audit, dashboard
src/migrations/           versioned schema migrations
scripts/                  initDb, migrate, backupDb, restoreDb (+ legacy one-off migrations)
```

## Roles

- **admin**: everything, including users, assignment, merge, archive/restore, settings and the audit log.
- **sales**: only leads assigned to them, plus their own reminders, appointments and activities.

## Lead score

Calculated live in SQL (0–100): the stage sets the base, then contact details, WhatsApp opt-in, deal
value and how recently there was activity adjust it. Open leads with a score ≥ 60 are **hot**,
30–59 **warm**, and below 30 **cold**.
