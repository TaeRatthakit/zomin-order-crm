# Zomin Order CRM Progress Report

Updated: 2026-07-10

## Current Status

Zomin Order CRM V3 has been upgraded from local-only demo toward production-ready Phase 1.

Latest production update:

- Commit: `db636d6 Improve additional expenses mobile UX`
- Production branch: `main`
- Production site: `https://www.growuppilot.com`
- Scope: Finance → Cost/Profit → Additional Expenses mobile UX and save feedback

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
- Improved Finance → Cost/Profit → Additional Expenses UX:
  - Mobile expense cards are compact by default
  - Edit fields expand only while editing
  - Enabled toggle remains visible on the compact card
  - Large add button changed to a smaller `+ Add` action
  - Helper card explains that additional expenses apply to every enabled product
  - Percentage helper example shows 2% of 1,000 THB = 20 THB
  - Save button now shows `Saving...`, disables while saving, then shows `✓ Saved`

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
- Finance → Cost/Profit → Additional Expenses on mobile and desktop

## Test Results

Latest local test used a temporary JSON database copy at `/tmp/zomin-test-db.json` so real `data/db.json` was not changed.

Passed:

- `npm run build`
- `npm test`
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
- Local Playwright visual/interaction verification:
  - Mobile Finance loaded the additional expenses section
  - Helper card appeared with the percentage example
  - Compact cards hid edit fields by default
  - `+ Add` created an editable row
  - Save feedback showed `Saving...` then `✓ Saved`
  - Temporary test expense saved through `/api/settings` and was restored away
  - Direct calculation check: 2% on 1,000 THB produced 20 THB expense and 980 THB profit before ads
- Production verification on `https://www.growuppilot.com`:
  - Production JS/CSS contained the deployed Additional Expenses UX changes
  - Mobile Finance matched the compact card behavior
  - Desktop Finance still loaded in `desktop-app-shell`
  - Desktop helper card and formula summary were present
  - Save feedback showed `Saving...` then `✓ Saved` on production
  - Production data save was verified with a temporary expense and restored
  - Production state was checked afterward; only the existing real `ค่าcod` expense remained
  - Production calculation check confirmed 2% on 1,000 THB = 20 THB expense

Not run:

- No current unverified blocker for the latest Additional Expenses UX work.

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
- `data/db.json` currently has unrelated local modifications in the worktree and was intentionally not included in the Additional Expenses UX commit.
