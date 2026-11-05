/**
 * Score submission pipeline.
 *
 *   startSession        -> server stamps the session start time (the anti-cheat anchor)
 *   submitSessionScore  -> validates the score, applies the daily cap, updates the weekly
 *                          leaderboard and writes an audit log, all in one Firestore transaction
 *
 * Firestore layout
 *   sessions/{sessionId}                         uid, startedAt, status, result
 *   players/{uid}/daily/{YYYY-MM-DD}             credited (UTC day)
 *   leaderboards/{YYYY-Www}/entries/{uid}        score, displayName, updatedAt (ISO week, UTC)
 *   auditLogs/{autoId}                           one row per submission attempt
 */
import { initializeApp } from "firebase-admin/app";
import {
  getFirestore,
  FieldValue,
  Timestamp,
  DocumentReference,
} from "firebase-admin/firestore";
import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";

initializeApp();
const db = getFirestore();

// ---- Tunables -------------------------------------------------------------
export const LIMITS = {
  /** Fastest legitimate scoring rate. Anything above is an impossible gain. */
  MAX_POINTS_PER_SECOND: 50,
  /** Hard ceiling for a single session regardless of length. */
  MAX_SCORE_PER_SESSION: 100_000,
  /** Sessions shorter than this are rejected (bot / replay protection). */
  MIN_SESSION_SECONDS: 10,
  /** Sessions open longer than this are treated as abandoned. */
  MAX_SESSION_SECONDS: 2 * 60 * 60,
  /** Slack for network latency between the last point and submission. */
  CLOCK_GRACE_SECONDS: 5,
  /** Max points credited to the leaderboard per player per UTC day. */
  DAILY_CAP: 250_000,
} as const;

const callableOpts = {
  region: "us-central1",
  // Turn on once App Check is configured for your clients.
  enforceAppCheck: false,
};

// ---- Types -----------------------------------------------------------------
type Outcome = "accepted" | "capped" | "rejected" | "duplicate";

type RejectReason =
  | "session_not_found"
  | "session_not_owned"
  | "session_too_short"
  | "session_expired"
  | "impossible_gain";

interface SubmitResult {
  outcome: Outcome;
  reason?: RejectReason;
  submittedScore: number;
  creditedScore: number;
  dailyCreditedAfter?: number;
  dailyRemaining?: number;
  weekId?: string;
}

// ---- Helpers ---------------------------------------------------------------
function requireUid(req: CallableRequest): string {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to submit scores.");
  return uid;
}

/** UTC calendar day, e.g. 2026-11-05 */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** ISO-8601 week in UTC, e.g. 2026-W45 (weeks start Monday). */
export function isoWeekId(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = date.getUTCDay() || 7; // Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - dow); // Thursday of this week decides the year
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Highest score that is physically achievable in the elapsed time. */
export function maxAllowedScore(elapsedSec: number): number {
  const byRate = Math.floor(
    (elapsedSec + LIMITS.CLOCK_GRACE_SECONDS) * LIMITS.MAX_POINTS_PER_SECOND
  );
  return Math.min(LIMITS.MAX_SCORE_PER_SESSION, byRate);
}

function parseInput(data: unknown): { sessionId: string; score: number } {
  const d = (data ?? {}) as Record<string, unknown>;
  const { sessionId, score } = d;
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    throw new HttpsError("invalid-argument", "sessionId is missing or malformed.");
  }
  if (typeof score !== "number" || !Number.isSafeInteger(score) || score < 0) {
    throw new HttpsError("invalid-argument", "score must be a non-negative integer.");
  }
  return { sessionId, score };
}

// ---- startSession ----------------------------------------------------------
export const startSession = onCall(callableOpts, async (req) => {
  const uid = requireUid(req);
  const ref = db.collection("sessions").doc();
  await ref.set({
    uid,
    status: "open",
    startedAt: FieldValue.serverTimestamp(),
  });
  return { sessionId: ref.id };
});

// ---- submitSessionScore ----------------------------------------------------
export const submitSessionScore = onCall(callableOpts, async (req): Promise<SubmitResult> => {
  const uid = requireUid(req);
  const { sessionId, score } = parseInput(req.data);
  const displayName =
    (req.auth?.token.name as string | undefined) ?? `player_${uid.slice(0, 6)}`;
  const ip = req.rawRequest?.ip ?? null;

  const sessionRef = db.collection("sessions").doc(sessionId);
  const auditRef = db.collection("auditLogs").doc();

  const result = await db.runTransaction(async (tx) => {
    // One server clock for every decision in this attempt.
    const now = Timestamp.now();
    const nowDate = now.toDate();
    const today = dayKey(nowDate);
    const weekId = isoWeekId(nowDate);
    const dailyRef = db.doc(`players/${uid}/daily/${today}`);
    const entryRef: DocumentReference = db.doc(`leaderboards/${weekId}/entries/${uid}`);

    // ---- reads (all reads must precede writes in a transaction) ----
    const [sessionSnap, dailySnap] = await Promise.all([tx.get(sessionRef), tx.get(dailyRef)]);

    const audit = (fields: Record<string, unknown>) =>
      tx.set(auditRef, {
        uid,
        sessionId,
        submittedScore: score,
        ip,
        appCheck: Boolean(req.app),
        dayKey: today,
        weekId,
        createdAt: FieldValue.serverTimestamp(),
        ...fields,
      });

    const reject = (reason: RejectReason, extra: Record<string, unknown> = {}): SubmitResult => {
      const res: SubmitResult = { outcome: "rejected", reason, submittedScore: score, creditedScore: 0 };
      audit({ outcome: "rejected", reason, creditedScore: 0, ...extra });
      // Only close sessions the caller owns; never touch someone else's.
      if (reason !== "session_not_found" && reason !== "session_not_owned") {
        tx.update(sessionRef, { status: "rejected", result: res, closedAt: now });
      }
      return res;
    };

    // ---- session checks ----
    if (!sessionSnap.exists) return reject("session_not_found");
    const session = sessionSnap.data()!;
    if (session.uid !== uid) return reject("session_not_owned");

    // Idempotent retry: return the original verdict, change nothing.
    if (session.status !== "open") {
      audit({ outcome: "duplicate", creditedScore: 0, originalResult: session.result ?? null });
      return { ...(session.result as SubmitResult), outcome: "duplicate" } as SubmitResult;
    }

    // ---- impossible-gain checks (server time only; client time is never trusted) ----
    const startedAt = session.startedAt as Timestamp;
    const elapsedSec = (now.toMillis() - startedAt.toMillis()) / 1000;
    const allowedMax = maxAllowedScore(elapsedSec);
    const timing = { elapsedSec, allowedMax };

    if (elapsedSec < LIMITS.MIN_SESSION_SECONDS) return reject("session_too_short", timing);
    if (elapsedSec > LIMITS.MAX_SESSION_SECONDS) return reject("session_expired", timing);
    if (score > allowedMax) return reject("impossible_gain", timing);

    // ---- daily cap ----
    const dailyBefore = (dailySnap.get("credited") as number | undefined) ?? 0;
    const remaining = Math.max(0, LIMITS.DAILY_CAP - dailyBefore);
    const credited = Math.min(score, remaining);
    const dailyAfter = dailyBefore + credited;
    const outcome: Outcome = credited < score ? "capped" : "accepted";

    // ---- writes ----
    if (credited > 0) {
      tx.set(
        dailyRef,
        { credited: FieldValue.increment(credited), updatedAt: now },
        { merge: true }
      );
      tx.set(
        entryRef,
        {
          uid,
          displayName,
          score: FieldValue.increment(credited),
          sessions: FieldValue.increment(1),
          updatedAt: now,
        },
        { merge: true }
      );
    }

    const res: SubmitResult = {
      outcome,
      submittedScore: score,
      creditedScore: credited,
      dailyCreditedAfter: dailyAfter,
      dailyRemaining: LIMITS.DAILY_CAP - dailyAfter,
      weekId,
    };

    tx.update(sessionRef, { status: "accepted", result: res, closedAt: now });
    audit({
      outcome,
      creditedScore: credited,
      dailyBefore,
      dailyAfter,
      ...timing,
    });
    return res;
  });

  if (result.outcome === "rejected") {
    logger.warn("score rejected", { uid, sessionId, score, reason: result.reason });
    const code =
      result.reason === "session_not_found" || result.reason === "session_not_owned"
        ? "not-found"
        : "failed-precondition";
    // The audit row is already committed; the client gets a structured error.
    throw new HttpsError(code, "Score rejected.", { reason: result.reason });
  }

  logger.info("score processed", { uid, sessionId, ...result });
  return result;
});
