import { test } from "node:test";
import assert from "node:assert/strict";

// Stub firebase-admin init so importing index.ts doesn't need credentials.
process.env.GCLOUD_PROJECT ??= "demo-test";
import { isoWeekId, dayKey, maxAllowedScore, LIMITS } from "./index";

test("ISO week ids", () => {
  assert.equal(isoWeekId(new Date("2026-11-05T12:00:00Z")), "2026-W45");
  assert.equal(isoWeekId(new Date("2027-01-01T00:00:00Z")), "2026-W53"); // Fri belongs to prev ISO year
  assert.equal(isoWeekId(new Date("2024-12-30T00:00:00Z")), "2025-W01"); // Mon belongs to next ISO year
});

test("day key is UTC", () => {
  assert.equal(dayKey(new Date("2026-11-05T23:30:00Z")), "2026-11-05");
});

test("max allowed score respects rate and ceiling", () => {
  assert.equal(maxAllowedScore(60), (60 + LIMITS.CLOCK_GRACE_SECONDS) * LIMITS.MAX_POINTS_PER_SECOND);
  assert.equal(maxAllowedScore(100_000), LIMITS.MAX_SCORE_PER_SESSION);
});
