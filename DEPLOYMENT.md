# GitHub Deployment

## 1. Push to GitHub

1. Create a new GitHub repository.
2. Upload the full `aceiiit-mock-portal` folder contents.
3. Keep `index.html` in the repo root.

## 2. Enable GitHub Pages

1. Open the repository on GitHub.
2. Go to `Settings > Pages`.
3. Under `Build and deployment`, choose:
   - `Source`: `Deploy from a branch`
   - `Branch`: `main` and `/ (root)`
4. Save.

GitHub will publish the site at:

- `https://<your-username>.github.io/<repo-name>/`

## 3. Firebase

In the portal admin, save:

- API key
- App ID
- Project ID
- Storage bucket

Then the app will sync Firestore-backed data across devices.

## 4. Firestore Rules

For this current client-only setup, use the rules in `firestore.rules`.

Important:

- these rules are open and not production-secure
- they are okay only for an early private launch
- before a larger public launch, the backend should move to a real auth-checked design

## 5. What works after deployment

- student login and signup
- admin builder mode
- tests, questions, attempts, leaderboard, analytics
- Firestore sync across devices
- image fallback through Firestore-safe compressed images

## 6. Important limitation

This Firebase project is not using Cloud Storage on the free plan, so image handling currently uses the app fallback path instead of Firebase Storage.
