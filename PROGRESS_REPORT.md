# Zomin Order CRM Progress Report

Updated: 2026-06-20

## Current Status

Zomin Order CRM V3 has been upgraded from local-only demo toward production-ready Phase 1.

Backup already exists:

- Backup branch: `backup/pre-production-ready-local-json`
- Backup commit: `7d9a6cd Backup working Zomin CRM before production prep`

## Completed

- Preserved local JSON mode with `DATABASE_PROVIDER=json`
- Added database adapter layer:
  - `lib/db/json-adapter.js`
  - `lib/db/supabase-adapter.js`
  - `lib/db/index.js`
- Added Supabase production schema:
  - `supabase/schema.sql`
- Added seed and migration scripts:
  - `npm run seed`
  - `npm run migrate:supabase`
- Added production verification:
  - `npm run build`
- Added deploy files:
  - `.env.example`
  - `README_DEPLOY.md`
  - `vercel.json`
  - `render.yaml`
- Upgraded authentication:
  - httpOnly signed cookie token
  - `SESSION_SECRET` required in production
  - password hash using Node `scrypt`
  - removed plain text demo passwords from `data/db.json`
- Added role guard:
  - Admin can access Settings, Team, Backup
  - Staff is blocked from Admin pages
  - CSV export is Admin-only unless `staffCanExport` is enabled
- Added export endpoints:
  - `/api/export/customers`
  - `/api/export/orders`
  - `/api/export/followups`
  - `/api/export/vip`
  - `/api/export/contact-logs`
  - `/api/backup`
- Added LINE Phase 1 readiness:
  - `/api/line/webhook`
  - signature verification with LINE Channel Secret
  - `/api/line/mock` for testing from Settings
  - Settings page has LINE Channel ID, Secret, Access Token, webhook copy, mock test

## Main Pages To Verify

- Login
- Dashboard
- Customers
- Orders
- Follow-up
- VIP
- Tags
- Import old orders
- Settings
- Team management
- Export / Backup

## Test Results

Latest local test used a temporary JSON database copy at `/tmp/zomin-test-db.json` so real `data/db.json` was not changed.

Passed:

- `npm run build`
- Syntax check for server, frontend JS, auth, DB adapters, scripts
- `GET /api/session` before login
- `GET /api/state` blocked with 401 before login
- Admin login with `admin / admin123`
- Dashboard state loaded with customers/orders/summary
- Static routes returned 200:
  - `/login`
  - `/dashboard`
  - `/customers`
  - `/orders`
  - `/follow-up`
  - `/more`
  - `/vip`
  - `/tags`
  - `/import`
  - `/reports`
  - `/settings`
  - `/team`
- Admin CSV export worked
- LINE mock webhook created one parsed order
- LINE webhook GET and POST worked in local mock mode
- Import preview parsed LINE text
- Staff login with `staff / staff123`
- Staff state returns only current user in `users`
- Staff blocked from Settings with 403
- Staff blocked from export while `staffCanExport=false`
- Logout returned success

Not run:

- Full visual browser automation was not run because Playwright is not installed in this dependency-free project. UI syntax/static routes and API workflows were verified.

## External Setup Still Required

- Create Supabase project
- Run `supabase/schema.sql`
- Set environment variables:
  - `DATABASE_PROVIDER=supabase`
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `SESSION_SECRET`
  - `NODE_ENV=production`
- Run `npm run migrate:supabase`
- Configure real LINE OA webhook URL after deployment

## Notes

- Password hashing uses Node built-in `scrypt` to keep the project dependency-free. It is production-grade for this app shape; bcrypt can be swapped in later if the project adds dependencies.
- The LINE webhook stores incoming messages and parses order text, but Phase 1 does not send reply messages back to LINE.
- Supabase service role key must stay server-side only.
