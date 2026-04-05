# AceIIIT Mock Portal

AceIIIT Mock Portal is a polished browser-based UGEE-style mock test system.

It includes:

- student sign up and login with password-based access
- admin login and builder mode
- UGEE-style instructions page and sectional exam interface
- locked SUPR to REAP flow with automatic section switching and auto submit
- on-screen calculator, analytics, reports, and solutions
- question authoring with custom marks, penalties, local image upload, and reference images
- live or draft test control for student visibility
- user, login, and attempt tracking in the admin view
- Firestore sync for users, tests, questions, attempts, settings, deleted items, and login events
- JSON export and import for full backup or transfer

## Run

1. Open `aceiiit-mock-portal/index.html` in a browser.
2. Sign up as a student using the access code issued by AceIIIT.
3. Log in as admin with:
   - email: `aceiiit.official@gmail.com`
   - password: `umnamotherboard`

## What is stored locally

The portal keeps a local browser copy for speed and offline-safe backup:

- users
- question bank
- tests
- attempts
- reports
- deleted questions
- deleted tests

## What is stored in backend

When Firebase config is saved in admin, Firestore also stores:

- `users`
- `tests`
- `questions`
- `attempts`
- `loginEvents`
- `deletedQuestions`
- `deletedTests`
- `portal_meta/settings`
- `portal_meta/backupMeta`

## Builder workflow

1. Log in with the admin account.
2. Open Builder Mode from the dashboard.
3. Create a test first with its title, durations, instructions, and benchmark scores.
4. Mark the test live when you want students to see it on their dashboard.
5. Add questions directly into the selected test, or attach existing bank questions.
6. Use local image upload in the question form. In the current setup, images are compressed into a Firestore-safe fallback path so they remain available across devices even without Firebase Storage.
7. Export the full dataset JSON whenever you want a backup.
8. Use the PDF button on a test to print or save the question-answer set.

## Firebase

1. Create a Firebase project.
2. Enable Firestore Database.
3. In Firestore, keep these collections available:
   - `portal_meta`
   - `users`
   - `tests`
   - `questions`
   - `attempts`
   - `loginEvents`
   - `deletedQuestions`
   - `deletedTests`
5. In the admin panel, paste:
   - API key
   - App ID
   - Project ID
   - Storage bucket
6. Save the config.
7. After that:
   - users, tests, questions, attempts, settings, deleted items, and login logs sync to Firestore
   - question images use the current compressed fallback path
   - students on different devices can see the same live tests and attempt data

## GitHub Pages deployment

This project is ready for GitHub Pages:

1. push all files to a GitHub repository
2. keep `index.html` in the repo root
3. go to `Settings > Pages`
4. choose `Deploy from a branch`
5. select `main` and `/ (root)`
6. wait for the GitHub Pages URL

The included `.nojekyll` file helps GitHub Pages serve the project as a plain static site.

See `DEPLOYMENT.md` for the exact checklist.

## Recommended first-launch backend for 50-70 students

This portal currently works around this free-first setup:

- Cloud Firestore for shared app data
- compressed Firestore-safe image fallback for question images
- local browser cache as a fallback and performance layer

That is workable for your first batch size, but the current open Firestore rules are not secure for a large public launch.

## Rules

The repo includes `firestore.rules` with the same open starter rules you used in Firebase Console.

Important:

- these rules are only for early private usage
- they are not safe for a broad public deployment
- a stronger backend/auth design should be added before scaling publicly
