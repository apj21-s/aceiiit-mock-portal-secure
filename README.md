# UGEE Mock Test Series Platform (No Firebase)

This is a production-oriented UGEE mock test series platform built on the existing AceIIIT exam UI (theme/layout preserved) with a new backend.

## Highlights

- Frontend: existing HTML/CSS/JS theme + exam UX preserved (palette, navigation, timer, answer states)
- Backend: Node.js + Express + MongoDB (Mongoose)
- Auth: email OTP login (Resend) + JWT sessions
- Access model: free + paid tests (paid is verified via Google Sheets)
- Evaluation: server-side only (correct answers are never sent to students)
- Analytics: score, accuracy, rank, percentile, section breakdown

## Local setup

### 1) Backend

From the project root:

1. `cd backend`
2. `npm install`
3. Copy `backend/.env.example` to `backend/.env` and fill values.
4. (Optional) Seed UGEE 2026 series: `npm run seed`
5. Start server: `npm start`

Open: `http://localhost:4000`

### 2) OTP email (Resend)

Configure these in `backend/.env`:

- `RESEND_API_KEY`

Note: the sender address is configured in the backend code and must be a verified sender/domain in Resend.

### 3) Admin access

Set admin emails (comma-separated) in `backend/.env`:

- `ADMIN_EMAILS=admin1@example.com,admin2@example.com`

Admins get the builder UI at `#/admin` after OTP login.

### 4) Paid verification (Google Sheets)

The backend periodically syncs a public Google Sheet column of verified emails (lowercased).

Configure in `backend/.env`:

- `PAID_SHEETS_API_KEY`
- `PAID_SHEETS_SHEET_ID`
- `PAID_SHEETS_RANGE` (example: `Verified!A:A`)

After an email becomes verified, the user should log out and log in again to refresh `isPaid` in their JWT.

## API (high level)

- `POST /api/auth/send-otp`
- `POST /api/auth/verify-otp`
- `GET /api/tests`
- `GET /api/tests/:id`
- `POST /api/attempt`
- `GET /api/result/:id`
- `GET /api/attempts`
- Admin:
  - `GET /api/admin/snapshot`
  - `GET /api/admin/results`
  - `GET /api/admin/leaderboard?testId=...`
  - `GET /api/admin/test/:id/analytics`
  - `POST /api/admin/questions`
  - `PUT /api/admin/questions/:id`
  - `DELETE /api/admin/questions/:id`
  - `POST /api/admin/attach`
  - `POST /api/admin/detach`

## Deployment

See `DEPLOYMENT.md` for Render deployment steps.

Notes:

- Authenticated access only
- Role-based writes for admin-only APIs
- Attempts/results are user-scoped (plus admin access)
