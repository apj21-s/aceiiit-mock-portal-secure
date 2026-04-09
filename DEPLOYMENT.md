# Render Deployment (Backend + Frontend Served Together)

This project serves the existing static frontend from the Express backend, so you deploy only one service.

## 1) Create MongoDB

- Use MongoDB Atlas (recommended) or a managed MongoDB provider.
- Copy the connection string to `MONGODB_URI`.

## 2) Create Render Web Service

- **Environment**: Node
- **Root Directory**: `ugee-mock-platform/backend`
- **Build Command**: `npm ci` (or `npm install`)
- **Start Command**: `node server.js`

## 3) Set environment variables (Render dashboard)

Required:

- `MONGODB_URI`
- `JWT_SECRET`
- `JWT_EXPIRES_IN` (example: `7d`)
- `ADMIN_EMAILS` (comma-separated)
- `REQUEST_TIMEOUT_MS` (recommended: `15000`)
- `SERVER_REQUEST_TIMEOUT_MS` (recommended: `15000`)
- `KEEP_ALIVE_TIMEOUT_MS` (recommended: `65000`)
- `HEADERS_TIMEOUT_MS` (recommended: `66000`)
- `MONGO_MAX_POOL_SIZE` (recommended: `25`)
- `MONGO_MIN_POOL_SIZE` (recommended: `3`)
- `MONGO_SERVER_SELECTION_TIMEOUT_MS` (recommended: `5000`)
- `MONGO_SOCKET_TIMEOUT_MS` (recommended: `15000`)
- `MONGO_CONNECT_TIMEOUT_MS` (recommended: `5000`)
- `DB_RETRY_DELAY_MS` (recommended: `5000`)
- `ATTEMPT_QUEUE_CONCURRENCY` (recommended: `8`)
- `ATTEMPT_QUEUE_MAX_SIZE` (recommended: `180`)
- `ATTEMPT_QUEUE_MAX_WAIT_MS` (recommended: `20000`)
- `UPLOAD_REQUEST_TIMEOUT_MS` (recommended: `45000`)

Email OTP (Resend recommended):

- `RESEND_API_KEY`
Note: the sender address is configured in the backend code and must be a verified sender/domain in Resend.

Google Sheets paid verification:

- `PAID_SHEETS_API_KEY`
- `PAID_SHEETS_SHEET_ID`
- `PAID_SHEETS_RANGE` (example: `Verified!A:A`)
- `PAID_SHEETS_SYNC_INTERVAL_SECONDS` (example: `300`)
- `PAID_SHEETS_STARTUP_DELAY_MS` (recommended: `10000`)

Optional (only if you split frontend and backend origins):

- `CORS_ORIGIN`

Cloudinary (question images):

- `CLOUDINARY_URL` (recommended)
  - `cloudinary://<api_key>:<api_secret>@<cloud_name>`
  - Or set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`

## 4) Seed (optional)

Locally:

- `cd backend`
- `npm run seed`

Or create a one-off job on your machine against the production `MONGODB_URI`.

## 5) Verify

- Open your Render URL.
- Login via OTP.
- Confirm `UGEE 2026` mocks appear on the dashboard.
- Submit a test and open the result screen.
- Open `/health` and confirm it returns a small JSON payload quickly.
- Open `/api/health` and confirm it returns immediately even while the service is still waking up.
- If you use UptimeRobot or another external pinger, point it to `/health` with a `10` minute interval.

## 6) Scaling notes (300+ concurrent users)

- Prefer a paid Render instance with more CPU/RAM for stable concurrency.
- Use a MongoDB cluster tier appropriate for write bursts during submissions.
- Keep the Google Sheet public-read (API key mode) or switch to service-account auth if you need private sheets.
- The submission route is smoothed by an in-memory FIFO queue. Start with `ATTEMPT_QUEUE_CONCURRENCY=8` and `ATTEMPT_QUEUE_MAX_SIZE=180` on a single instance, then tune upward only after load testing.
