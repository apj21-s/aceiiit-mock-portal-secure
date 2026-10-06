# ARCHITECTURAL DECISIONS

## 1. Authentication Separation
**Decision**: Calendar synchronization will be implemented as a completely standalone OAuth 2.0 flow, decoupled from the main identity login flow. 
**Rationale**: The existing system uses frontend-generated ID tokens for login. Converting login to an offline backend-flow just to acquire calendar permissions would break the existing login behavior and require all users to grant calendar scopes to log in. By keeping them separate, we strictly abide by the principle of least privilege.

## 2. Token Storage
**Decision**: A new `GoogleCalendarConnection` database model will be introduced. 
**Rationale**: To maintain the 1-to-1 relationship with the user and securely store the OAuth `refresh_token`, rather than bloating the main `User` model.
