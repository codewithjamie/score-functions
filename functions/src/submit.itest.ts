/**
 * Integration tests: run the real function code against the Firestore emulator.
 *   npm run test:integration
 * (wraps the run in `firebase emulators:exec`, which sets FIRESTORE_EMULATOR_HOST)
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

process.env.GCLOUD_PROJECT ??= "demo-test";
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("Run via `npm run test:integration` so the Firestore emulator is up.");
}

import { submitSessionScore, LIMITS, dayKey, isoWeekId } from "./index";
import { getFirestore } from "firebase-admin/firestore";

const db = getFirestore();
const PROJECT = process.env.GCLOUD_PROJECT;

// ---- helpers ---------------------------------------------------------------
async function clearDb() {
  await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }
  );
}

/** Create an open session that started `ageSec` seconds ago. */
async function openSession(uid: string, ageSec: number): Promise<string> {
  const ref = db.collection("sessions").doc();
  await ref.set({
    uid,
    status: "open",
    startedAt: Timestamp.fromMillis(Date.now() - ageSec * 1000),
  });
  return ref.id;
}

/** Call the callable exactly as Firebase would, as a signed-in user. */
function submit(uid: string, sessionId: string, score: number) {
  return submitSessionScore.run({
    data: { sessionId, score },
    auth: { uid, token: { name: `Tester ${uid}` } },
    rawRequest: { ip: "203.0.113.7" },
  } as any);
}

async function leaderboardScore(uid: string): Promise<number | undefined> {
  const snap = await db.doc(`leaderboards/${isoWeekId(new Date())}/entries/${uid}`).get();
  return snap.get("score");
}

async function auditRows(uid: string) {
  const snap = await db.collection("auditLogs").where("uid", "==", uid).get();
  return snap.docs.map((d) => d.data());
}

async function expectRejected(p: Promise<unknown>, reason: string) {
  await assert.rejects(p, (err: any) => {
    assert.equal(err.details?.reason, reason);
    return true;
  });
}

beforeEach(clearDb);

// ---- tests -----------------------------------------------------------------
test("valid score is credited, leaderboard updated, audit written", async () => {
  const sid = await openSession("alice", 120);
  const res = await submit("alice", sid, 3000);

  assert.equal(res.outcome, "accepted");
  assert.equal(res.creditedScore, 3000);
  assert.equal(await leaderboardScore("alice"), 3000);

  const [row] = await auditRows("alice");
  assert.equal(row.outcome, "accepted");
  assert.equal(row.creditedScore, 3000);
  assert.equal(row.ip, "203.0.113.7");
});

test("scores accumulate across sessions in the same week", async () => {
  await submit("bob", await openSession("bob", 60), 1000);
  await submit("bob", await openSession("bob", 60), 2500);
  assert.equal(await leaderboardScore("bob"), 3500);
});

test("impossible gain is rejected and nothing is credited", async () => {
  const sid = await openSession("carol", 30); // 30s → max (30+5)*50 = 1750
  await expectRejected(submit("carol", sid, 50_000), "impossible_gain");

  assert.equal(await leaderboardScore("carol"), undefined);
  const [row] = await auditRows("carol");
  assert.equal(row.outcome, "rejected");
  assert.equal(row.reason, "impossible_gain");
  assert.ok(row.allowedMax < 50_000);
  assert.equal((await db.doc(`sessions/${sid}`).get()).get("status"), "rejected");
});

test("score exactly at the limit is accepted", async () => {
  const sid = await openSession("dan", 30);
  const res = await submit("dan", sid, 1750);
  assert.equal(res.outcome, "accepted");
});

test("too-short session is rejected", async () => {
  const sid = await openSession("erin", 2);
  await expectRejected(submit("erin", sid, 10), "session_too_short");
});

test("expired session is rejected", async () => {
  const sid = await openSession("erin", LIMITS.MAX_SESSION_SECONDS + 60);
  await expectRejected(submit("erin", sid, 10), "session_expired");
});

test("someone else's session is rejected and left untouched", async () => {
  const sid = await openSession("frank", 60);
  await expectRejected(submit("mallory", sid, 100), "session_not_owned");
  assert.equal((await db.doc(`sessions/${sid}`).get()).get("status"), "open");
});

test("unknown session is rejected", async () => {
  await expectRejected(submit("frank", "does-not-exist", 100), "session_not_found");
});

test("resubmitting the same session never double-credits", async () => {
  const sid = await openSession("gina", 60);
  await submit("gina", sid, 1000);
  const again = await submit("gina", sid, 1000);

  assert.equal(again.outcome, "duplicate");
  assert.equal(await leaderboardScore("gina"), 1000);
  assert.equal((await auditRows("gina")).length, 2); // both attempts audited
});

test("daily cap credits only what fits, then nothing", async () => {
  // Pretend the player already earned all but 1000 points today.
  await db.doc(`players/hank/daily/${dayKey(new Date())}`).set({
    credited: LIMITS.DAILY_CAP - 1000,
  });

  const first = await submit("hank", await openSession("hank", 600), 5000);
  assert.equal(first.outcome, "capped");
  assert.equal(first.creditedScore, 1000);
  assert.equal(first.dailyRemaining, 0);

  const second = await submit("hank", await openSession("hank", 600), 5000);
  assert.equal(second.creditedScore, 0);
  assert.equal(await leaderboardScore("hank"), 1000);
});

test("bad input is refused before touching the database", async () => {
  await assert.rejects(submit("ivy", "x", -5), /non-negative integer/);
  await assert.rejects(submit("ivy", "x", 1.5), /non-negative integer/);
  await assert.rejects(submit("ivy", "../etc", 10), /malformed/);
});

test("signed-out callers are refused", async () => {
  await assert.rejects(
    submitSessionScore.run({ data: { sessionId: "x", score: 1 } } as any),
    /Sign in/
  );
});
