/**
 * Waiting-list FCFS promotion when a session seat opens.
 * Uses a short promo lock to avoid concurrent double-enrolls.
 */

import {
  getCourse,
  getSession,
  getStudent,
  releasePromoLock,
  saveSession,
  tryAcquirePromoLock,
} from "../store/repo.js";
import {
  processEnrollmentPayment,
  paymentSuccessMessage,
} from "./payments.js";

export type PromoteResult =
  | {
      ok: true;
      studentId: string;
      chatId: number;
      message: string;
    }
  | { ok: false; reason: "empty" | "full" | "locked" | "gone" | "pay_failed"; detail?: string };

/**
 * Promote the next waiting-list student into a free seat (if any).
 * Safe to call repeatedly — no-ops when full or empty.
 */
export async function promoteNextFromWaitingList(
  sessionId: string,
): Promise<PromoteResult> {
  const locked = await tryAcquirePromoLock(sessionId);
  if (!locked) return { ok: false, reason: "locked" };

  try {
    // Re-read under lock
    const session = await getSession(sessionId);
    if (!session || session.status !== "scheduled") {
      return { ok: false, reason: "gone" };
    }
    if (session.enrolledIds.length >= session.capacity) {
      return { ok: false, reason: "full" };
    }
    if (session.waitingList.length === 0) {
      return { ok: false, reason: "empty" };
    }

    const studentId = session.waitingList[0]!;
    // Remove from waitlist first so a failed pay doesn't re-pick forever without progress
    session.waitingList = session.waitingList.slice(1);
    await saveSession(session);

    const course = await getCourse(session.courseId);
    if (!course) return { ok: false, reason: "gone" };

    const pay = await processEnrollmentPayment({
      studentId,
      courseId: course.id,
      sessionId: session.id,
    });

    if (!pay.ok) {
      // Put them back at the front if charge failed for a non-full reason
      const s2 = await getSession(sessionId);
      if (s2 && pay.reason.includes("full") === false) {
        s2.waitingList = [studentId, ...s2.waitingList.filter((id) => id !== studentId)];
        await saveSession(s2);
      }
      return { ok: false, reason: "pay_failed", detail: pay.reason };
    }

    const student = await getStudent(studentId);
    const tz = student?.timezone ?? "UTC";
    const message =
      `A seat opened up — you're in!\n\n` +
      paymentSuccessMessage({
        courseTitle: course.title,
        amount: pay.payment.amount,
        currency: pay.payment.currency,
        startTime: pay.session.startTime,
        timezone: tz,
        joinUrl: pay.joinUrl,
      });

    return {
      ok: true,
      studentId,
      chatId: student?.chatId ?? 0,
      message,
    };
  } finally {
    await releasePromoLock(sessionId);
  }
}

/**
 * After a cancellation frees a seat, promote as many waitlisted students as
 * there are free spots (one at a time, FCFS). Returns notification payloads
 * the caller should DM (tolerating 403).
 */
export async function promoteUntilFull(
  sessionId: string,
): Promise<Array<{ chatId: number; message: string; studentId: string }>> {
  const notices: Array<{ chatId: number; message: string; studentId: string }> = [];
  for (let i = 0; i < 50; i++) {
    const result = await promoteNextFromWaitingList(sessionId);
    if (!result.ok) break;
    if (result.chatId) {
      notices.push({
        chatId: result.chatId,
        message: result.message,
        studentId: result.studentId,
      });
    }
  }
  return notices;
}

/** Add student to waiting list (FCFS). Returns position (1-based) or error. */
export async function joinWaitingList(
  sessionId: string,
  studentId: string,
): Promise<{ ok: true; position: number } | { ok: false; reason: string }> {
  const session = await getSession(sessionId);
  if (!session || session.status !== "scheduled") {
    return { ok: false, reason: "That session isn't available." };
  }
  if (session.enrolledIds.includes(studentId)) {
    return { ok: false, reason: "You're already enrolled — no need for the waiting list." };
  }
  if (session.waitingList.includes(studentId)) {
    const position = session.waitingList.indexOf(studentId) + 1;
    return { ok: true, position };
  }
  // Only waitlist when full (or always allow pre-wait? Spec: capacity overflow)
  if (session.enrolledIds.length < session.capacity) {
    return {
      ok: false,
      reason: "There's still a free spot — enroll directly instead of waiting.",
    };
  }
  session.waitingList.push(studentId);
  await saveSession(session);
  return { ok: true, position: session.waitingList.length };
}
