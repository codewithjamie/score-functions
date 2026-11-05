# Score submission Cloud Functions

Firebase Cloud Functions (2nd gen, TypeScript) for end-of-session score submission.

- `startSession` stamps a server-side session start time.
- `submitSessionScore` rejects impossible gains, applies a daily cap, updates the weekly
  leaderboard (ISO week, UTC) and writes an audit log, all in one Firestore transaction.

Thresholds live in `LIMITS` at the top of `functions/src/index.ts`.

## Test locally

Requires Node 20 and Java 11+.

```bash
cd functions
npm install
npm test                  # unit tests
npm run test:integration  # runs against the Firestore emulator
```

## Deploy

Every push to `main` runs the tests and then deploys through GitHub Actions
(`.github/workflows/ci-deploy.yml`). Pull requests run the tests only.

One-time setup in the repo's **Settings → Secrets and variables → Actions**:

| Kind | Name | Value |
|---|---|---|
| Variable | `FIREBASE_PROJECT_ID` | your Firebase project ID |
| Secret | `FIREBASE_SERVICE_ACCOUNT` | JSON key of a service account with deploy rights |

The service account needs these roles: Cloud Functions Admin, Firebase Rules Admin,
Cloud Datastore Index Admin, Service Account User, Artifact Registry Administrator,
Cloud Build Editor. The project must be on the Blaze plan.

Until `FIREBASE_PROJECT_ID` is set, the workflow only runs tests.

Manual deploy: `cd functions && npx firebase deploy --only functions,firestore:rules,firestore:indexes --project <id>`
