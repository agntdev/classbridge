/**
 * Marketplace payment processing.
 *
 * Charges and refunds are recorded as durable Payment entities. When a real
 * external provider URL is not configured (no required_env in the blueprint),
 * the internal marketplace ledger settles instantly — this keeps enrollment,
 * refunds, and teacher payout tracking real and testable without inventing
 * secrets. Secure tokens never leave the process or get echoed to users.
 */

import { now } from "./clock.js";
import {
  createEnrollment,
  createPaymentRecord,
  getEnrollment,
  getPayment,
  getSession,
  saveEnrollment,
  savePayment,
  saveSession,
  scheduleReminder,
  getCourse,
  getStudent,
  listEnrollmentsForStudent,
} from "../store/repo.js";
import type { Enrollment, Payment, Session } from "../store/models.js";
import { formatInTimezone, formatPrice, msUntil } from "./time.js";

export type PayResult =
  | {
      ok: true;
      payment: Payment;
      enrollment: Enrollment;
      session: Session;
      joinUrl: string;
    }
  | { ok: false; reason: string };

export type RefundResult =
  | { ok: true; payment: Payment; enrollment: Enrollment }
  | { ok: false; reason: string };

/**
 * Charge a one-time course fee and enroll the student in the session.
 * Fails cleanly when the session is full, cancelled, or the student is already in.
 */
export async function processEnrollmentPayment(input: {
  studentId: string;
  courseId: string;
  sessionId: string;
}): Promise<PayResult> {
  const course = await getCourse(input.courseId);
  if (!course || !course.active) {
    return { ok: false, reason: "That course isn't available anymore." };
  }

  const session = await getSession(input.sessionId);
  if (!session || session.courseId !== course.id) {
    return { ok: false, reason: "That session couldn't be found." };
  }
  if (session.status === "cancelled") {
    return { ok: false, reason: "This session was cancelled by the teacher." };
  }
  if (session.status === "completed") {
    return { ok: false, reason: "This session has already finished." };
  }
  if (session.enrolledIds.includes(input.studentId)) {
    return { ok: false, reason: "You're already enrolled in this session." };
  }
  if (session.enrolledIds.length >= session.capacity) {
    return {
      ok: false,
      reason: "This session is full. Join the waiting list to get the next open spot.",
    };
  }

  const amount = course.price;
  if (!(amount >= 0) || Number.isNaN(amount)) {
    return { ok: false, reason: "This course has an invalid price. Ask the teacher to fix it." };
  }

  // Marketplace charge — internal ledger settles immediately.
  // providerRef is an opaque receipt id (never shown raw to users as a secret).
  const providerRef = `mkt_${now().getTime()}_${input.studentId.slice(-4)}`;

  // Reuse a waitlisted enrollment for this session if one exists
  const existingList = await listEnrollmentsForStudent(input.studentId);
  let enrollment =
    existingList.find(
      (e) =>
        e.sessionIds.includes(session.id) &&
        (e.status === "waitlisted" || e.status === "active"),
    ) ?? null;

  if (enrollment?.status === "active" && enrollment.paymentStatus === "paid") {
    return { ok: false, reason: "You're already enrolled in this session." };
  }

  if (!enrollment) {
    enrollment = await createEnrollment({
      studentId: input.studentId,
      courseId: course.id,
      sessionIds: [session.id],
      paymentId: "pending",
      paymentStatus: "paid",
      status: "active",
    });
  } else {
    enrollment.status = "active";
    enrollment.paymentStatus = "paid";
    enrollment.courseId = course.id;
    if (!enrollment.sessionIds.includes(session.id)) {
      enrollment.sessionIds.push(session.id);
    }
    await saveEnrollment(enrollment);
  }

  const payment = await createPaymentRecord({
    amount,
    currency: course.currency,
    studentId: input.studentId,
    courseId: course.id,
    sessionId: session.id,
    enrollmentId: enrollment.id,
    status: "paid",
    providerRef,
  });

  enrollment.paymentId = payment.id;
  enrollment.paymentStatus = "paid";
  enrollment.status = "active";
  await saveEnrollment(enrollment);

  session.enrolledIds.push(input.studentId);
  // Drop from waiting list if they were on it
  session.waitingList = session.waitingList.filter((id) => id !== input.studentId);
  await saveSession(session);

  await scheduleSessionReminders({
    session,
    studentId: input.studentId,
    courseTitle: course.title,
  });

  return {
    ok: true,
    payment,
    enrollment,
    session,
    joinUrl: session.joinUrl,
  };
}

/**
 * Refund a paid enrollment (cancellation by student or teacher).
 */
export async function processRefund(input: {
  enrollmentId: string;
  reason?: string;
}): Promise<RefundResult> {
  const enrollment = await getEnrollment(input.enrollmentId);
  if (!enrollment) {
    return { ok: false, reason: "Couldn't find that enrollment." };
  }
  if (enrollment.status === "cancelled" && enrollment.paymentStatus === "refunded") {
    return { ok: false, reason: "This enrollment was already refunded." };
  }

  const payment = await getPayment(enrollment.paymentId);
  if (!payment) {
    // Waitlisted with no charge
    enrollment.status = "cancelled";
    enrollment.paymentStatus = "refunded";
    await saveEnrollment(enrollment);
    return {
      ok: true,
      payment: {
        id: "none",
        amount: 0,
        currency: "USD",
        studentId: enrollment.studentId,
        courseId: enrollment.courseId,
        sessionId: enrollment.sessionIds[0] ?? "",
        enrollmentId: enrollment.id,
        refundStatus: "refunded",
        status: "refunded",
        providerRef: "",
        createdAt: now().toISOString(),
        refundedAt: now().toISOString(),
      },
      enrollment,
    };
  }

  if (payment.status === "refunded" || payment.refundStatus === "refunded") {
    return { ok: false, reason: "This payment was already refunded." };
  }

  if (payment.status !== "paid") {
    return { ok: false, reason: "There's no successful payment to refund." };
  }

  payment.status = "refunded";
  payment.refundStatus = "refunded";
  payment.refundedAt = now().toISOString();
  await savePayment(payment);

  enrollment.status = "cancelled";
  enrollment.paymentStatus = "refunded";
  await saveEnrollment(enrollment);

  // Free the seat(s)
  for (const sid of enrollment.sessionIds) {
    const session = await getSession(sid);
    if (!session) continue;
    session.enrolledIds = session.enrolledIds.filter((id) => id !== enrollment.studentId);
    await saveSession(session);
  }

  return { ok: true, payment, enrollment };
}

/** Schedule 24h and 30m session reminders for an enrolled student. */
export async function scheduleSessionReminders(input: {
  session: Session;
  studentId: string;
  courseTitle: string;
}): Promise<void> {
  const student = await getStudent(input.studentId);
  if (!student) return;

  const startMs = new Date(input.session.startTime).getTime();
  if (Number.isNaN(startMs)) return;

  const when = formatInTimezone(input.session.startTime, student.timezone);
  const join = input.session.joinUrl;

  const plans: Array<{ kind: "24h" | "30m"; offsetMs: number; label: string }> = [
    {
      kind: "24h",
      offsetMs: 24 * 60 * 60 * 1000,
      label: `Reminder: "${input.courseTitle}" starts in 24 hours (${when}). Join link: ${join}`,
    },
    {
      kind: "30m",
      offsetMs: 30 * 60 * 1000,
      label: `Starting soon: "${input.courseTitle}" begins in 30 minutes (${when}). Join: ${join}`,
    },
  ];

  for (const p of plans) {
    const fireAtMs = startMs - p.offsetMs;
    if (fireAtMs <= now().getTime()) continue; // already past the window
    await scheduleReminder({
      sessionId: input.session.id,
      studentId: input.studentId,
      chatId: student.chatId,
      fireAt: new Date(fireAtMs).toISOString(),
      kind: p.kind,
      text: p.label,
    });
  }
}

export function paymentSuccessMessage(input: {
  courseTitle: string;
  amount: number;
  currency: string;
  startTime: string;
  timezone: string;
  joinUrl: string;
}): string {
  const when = formatInTimezone(input.startTime, input.timezone);
  const price = formatPrice(input.amount, input.currency);
  return (
    `You're enrolled in ${input.courseTitle}.\n\n` +
    `Payment: ${price} — received.\n` +
    `Session: ${when}\n` +
    `Join link: ${input.joinUrl}\n\n` +
    `We'll remind you 24 hours and 30 minutes before it starts.`
  );
}

export function refundSuccessMessage(input: {
  courseTitle: string;
  amount: number;
  currency: string;
}): string {
  const price = formatPrice(input.amount, input.currency);
  return (
    `Your enrollment in ${input.courseTitle} is cancelled.\n\n` +
    `Refund of ${price} is on the way — it usually shows up within a few days.`
  );
}

/** Human-readable time-until helper for empty/edge copy. */
export function describeTimeUntil(iso: string): string {
  const ms = msUntil(iso);
  if (ms < 0) return "started";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  return `in ${days}d`;
}
