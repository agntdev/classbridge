/**
 * Programmatic coverage for payment, refund, waiting-list promotion, and
 * timezone-aware scheduling — paths that need multi-user durable state and
 * an injectable clock beyond declarative BotSpec JSON.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { resetDurableStore } from "../src/store/kv.js";
import { setNow, now } from "../src/lib/clock.js";
import { resetReminderSweepThrottle, sweepDueReminders } from "../src/lib/reminders.js";
import {
  ensureTeacher,
  ensureStudent,
  createCourse,
  createSession,
  getSession,
  listActiveCourses,
  saveTeacher,
  saveStudent,
} from "../src/store/repo.js";
import {
  processEnrollmentPayment,
  processRefund,
} from "../src/lib/payments.js";
import {
  joinWaitingList,
  promoteUntilFull,
} from "../src/lib/waiting-list.js";
import { parseSessionTime, formatInTimezone, isValidTimezone } from "../src/lib/time.js";

beforeEach(() => {
  resetDurableStore();
  resetReminderSweepThrottle();
  setNow(Date.parse("2026-07-23T12:00:00.000Z"));
});

describe("timezone-aware session scheduling", () => {
  it("parses local wall time in a teacher timezone into UTC ISO", () => {
    expect(isValidTimezone("America/New_York")).toBe(true);
    const iso = parseSessionTime("2026-12-01 18:00", "UTC");
    expect(iso).toBe("2026-12-01T18:00:00.000Z");
  });

  it("rejects past times and invalid strings", () => {
    expect(parseSessionTime("2020-01-01 10:00", "UTC")).toBeNull();
    expect(parseSessionTime("not-a-date", "UTC")).toBeNull();
  });

  it("formats for a viewer timezone and falls back on bad zones", () => {
    const iso = "2026-12-01T18:00:00.000Z";
    const utc = formatInTimezone(iso, "UTC");
    expect(utc).toContain("2026");
    const bad = formatInTimezone(iso, "Not/A_Zone");
    expect(bad).toMatch(/UTC/);
  });
});

describe("payment + enrollment + refund", () => {
  it("charges once, enrolls, then refunds and frees the seat", async () => {
    const teacher = await ensureTeacher(10, 10, {
      name: "Ada",
      timezone: "UTC",
    });
    await saveTeacher({ ...teacher, name: "Ada", timezone: "UTC" });

    const student = await ensureStudent(20, 20, {
      name: "Sam",
      timezone: "UTC",
    });
    await saveStudent({ ...student, name: "Sam", timezone: "UTC" });

    const course = await createCourse({
      teacherId: teacher.id,
      title: "Design Lab",
      price: 25,
    });
    const session = await createSession({
      courseId: course.id,
      teacherId: teacher.id,
      startTime: "2026-12-15T10:00:00.000Z",
      capacity: 1,
      joinUrl: "https://meet.example.com/design",
    });

    const pay = await processEnrollmentPayment({
      studentId: student.id,
      courseId: course.id,
      sessionId: session.id,
    });
    expect(pay.ok).toBe(true);
    if (!pay.ok) return;
    expect(pay.payment.status).toBe("paid");
    expect(pay.enrollment.status).toBe("active");
    expect(pay.joinUrl).toBe("https://meet.example.com/design");

    const seated = await getSession(session.id);
    expect(seated?.enrolledIds).toContain(student.id);
    expect(seated?.enrolledIds.length).toBe(1);

    const refund = await processRefund({ enrollmentId: pay.enrollment.id });
    expect(refund.ok).toBe(true);
    if (!refund.ok) return;
    expect(refund.payment.status).toBe("refunded");
    expect(refund.enrollment.status).toBe("cancelled");

    const after = await getSession(session.id);
    expect(after?.enrolledIds).not.toContain(student.id);
  });

  it("fails payment when session is full", async () => {
    const teacher = await ensureTeacher(10, 10, { name: "Ada", timezone: "UTC" });
    await saveTeacher({ ...teacher, name: "Ada", timezone: "UTC" });
    const a = await ensureStudent(20, 20, { name: "A", timezone: "UTC" });
    await saveStudent({ ...a, name: "A" });
    const b = await ensureStudent(21, 21, { name: "B", timezone: "UTC" });
    await saveStudent({ ...b, name: "B" });

    const course = await createCourse({
      teacherId: teacher.id,
      title: "Tiny Class",
      price: 10,
    });
    const session = await createSession({
      courseId: course.id,
      teacherId: teacher.id,
      startTime: "2026-12-15T10:00:00.000Z",
      capacity: 1,
      joinUrl: "https://meet.example.com/tiny",
    });

    const first = await processEnrollmentPayment({
      studentId: a.id,
      courseId: course.id,
      sessionId: session.id,
    });
    expect(first.ok).toBe(true);

    const second = await processEnrollmentPayment({
      studentId: b.id,
      courseId: course.id,
      sessionId: session.id,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toMatch(/full|waiting list/i);
  });
});

describe("waiting list auto-promotion", () => {
  it("promotes the next waitlisted student and notifies", async () => {
    const teacher = await ensureTeacher(10, 10, { name: "Ada", timezone: "UTC" });
    await saveTeacher({ ...teacher, name: "Ada", timezone: "UTC" });
    const a = await ensureStudent(20, 20, { name: "A", timezone: "UTC" });
    await saveStudent({ ...a, name: "A", timezone: "UTC" });
    const b = await ensureStudent(21, 21, { name: "B", timezone: "UTC" });
    await saveStudent({ ...b, name: "B", timezone: "UTC" });

    const course = await createCourse({
      teacherId: teacher.id,
      title: "Full House",
      price: 15,
    });
    const session = await createSession({
      courseId: course.id,
      teacherId: teacher.id,
      startTime: "2026-12-20T15:00:00.000Z",
      capacity: 1,
      joinUrl: "https://meet.example.com/full",
    });

    const first = await processEnrollmentPayment({
      studentId: a.id,
      courseId: course.id,
      sessionId: session.id,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const wait = await joinWaitingList(session.id, b.id);
    expect(wait.ok).toBe(true);
    if (!wait.ok) return;
    expect(wait.position).toBe(1);

    // A cancels → seat opens → B promoted
    const refund = await processRefund({ enrollmentId: first.enrollment.id });
    expect(refund.ok).toBe(true);

    const notices = await promoteUntilFull(session.id);
    expect(notices.length).toBe(1);
    expect(notices[0]!.studentId).toBe(b.id);
    expect(notices[0]!.message).toMatch(/seat opened|enrolled|Join link/i);

    const final = await getSession(session.id);
    expect(final?.enrolledIds).toContain(b.id);
    expect(final?.enrolledIds).not.toContain(a.id);
    expect(final?.waitingList).not.toContain(b.id);
  });
});

describe("session reminders", () => {
  it("fires 24h and 30m reminders when the clock advances", async () => {
    const teacher = await ensureTeacher(10, 10, { name: "Ada", timezone: "UTC" });
    await saveTeacher({ ...teacher, name: "Ada", timezone: "UTC" });
    const student = await ensureStudent(20, 20, { name: "Sam", timezone: "UTC" });
    await saveStudent({ ...student, name: "Sam", timezone: "UTC" });

    const start = "2026-07-25T12:00:00.000Z"; // 48h after frozen now
    const course = await createCourse({
      teacherId: teacher.id,
      title: "Reminder Course",
      price: 5,
    });
    const session = await createSession({
      courseId: course.id,
      teacherId: teacher.id,
      startTime: start,
      capacity: 5,
      joinUrl: "https://meet.example.com/rem",
    });

    const pay = await processEnrollmentPayment({
      studentId: student.id,
      courseId: course.id,
      sessionId: session.id,
    });
    expect(pay.ok).toBe(true);

    const sent: Array<{ chatId: number; text: string }> = [];
    const api = {
      sendMessage: async (chatId: number, text: string) => {
        sent.push({ chatId, text });
      },
    };

    // Still early — nothing due
    resetReminderSweepThrottle();
    await sweepDueReminders(api);
    expect(sent.length).toBe(0);

    // Jump to 24h window
    setNow(Date.parse("2026-07-24T12:00:00.000Z"));
    resetReminderSweepThrottle();
    await sweepDueReminders(api);
    expect(sent.some((m) => /24 hours/i.test(m.text))).toBe(true);

    // Jump to 30m window
    setNow(Date.parse("2026-07-25T11:30:00.000Z"));
    resetReminderSweepThrottle();
    await sweepDueReminders(api);
    expect(sent.some((m) => /30 minutes/i.test(m.text))).toBe(true);

    expect(now().toISOString()).toBe("2026-07-25T11:30:00.000Z");
  });
});

describe("catalog index", () => {
  it("lists active courses without keyspace scans", async () => {
    const teacher = await ensureTeacher(10, 10, { name: "Ada", timezone: "UTC" });
    await saveTeacher({ ...teacher, name: "Ada", timezone: "UTC" });
    await createCourse({ teacherId: teacher.id, title: "A", price: 1 });
    await createCourse({ teacherId: teacher.id, title: "B", price: 2 });
    const list = await listActiveCourses();
    expect(list.map((c) => c.title).sort()).toEqual(["A", "B"]);
  });
});
