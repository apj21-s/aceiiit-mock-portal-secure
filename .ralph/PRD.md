# GOOGLE CALENDAR AUTOMATIC SYNC - PRD

## OVERVIEW
Implement automatic, reliable Google Calendar synchronization for scheduled mock tests within the ACEIIIT Mock Portal. The portal remains the absolute source of truth.

## REQUIREMENTS & ARCHITECTURE
- **Auth**: Existing Google login (Identity scopes) remains unchanged. Calendar requires an explicit opt-in OAuth flow (`https://www.googleapis.com/auth/calendar.events`) for offline access.
- **Sync**: Reschedules update the existing event. Cancellations delete the event.
- **Resilience**: Ensure idempotency, race condition protection, and proper API error handling (exponential backoff/retries).
- **Timezone**: Strict UTC/IST handling.

## RALPH TASK LIST
- [x] **TASK 1**: Repository reconnaissance
- [x] **TASK 2**: Create PRD/state files
- [ ] **TASK 3**: Understand existing Google OAuth
- [ ] **TASK 4**: Verify Google Cloud configuration compatibility
- [ ] **TASK 5**: Database schema/migrations (GoogleConnection, GoogleEventMapping)
- [ ] **TASK 6**: Calendar OAuth connect flow
- [ ] **TASK 7**: OAuth callback/token storage
- [ ] **TASK 8**: Calendar service abstraction
- [ ] **TASK 9**: Token refresh
- [ ] **TASK 10**: Create event synchronization
- [ ] **TASK 11**: Idempotency/race protection
- [ ] **TASK 12**: Rescheduling synchronization
- [ ] **TASK 13**: Cancellation synchronization
- [ ] **TASK 14**: Disconnect behavior
- [ ] **TASK 15**: Frontend connection UI
- [ ] **TASK 16**: Sync status UI
- [ ] **TASK 17**: Background jobs/retry mechanism
- [ ] **TASK 18**: Unit tests
- [ ] **TASK 19**: Integration tests
- [ ] **TASK 20**: Security audit
- [ ] **TASK 21**: Timezone audit
- [ ] **TASK 22**: Real Google test
- [ ] **TASK 23**: Documentation
- [ ] **TASK 24**: Final regression test
- [ ] **TASK 25**: Final code review
