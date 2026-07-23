/**
 * Domain repository — all durable reads/writes go through explicit keys and
 * index records. Never KEYS/SCAN.
 */

import { shortId } from "../lib/ids.js";
import { now } from "../lib/clock.js";
import { kvGet, kvSet } from "./kv.js";
import {
  keys,
  type Course,
  type CourseIndex,
  type Enrollment,
  type Payment,
  type Reminder,
  type ReminderIndex,
  type Session,
  type Student,
  type Teacher,
} from "./models.js";

// ─── Teacher ───────────────────────────────────────────────────────────────

export async function getTeacher(id: string): Promise<Teacher | undefined> {
  return kvGet<Teacher>(keys.teacher(id));
}

export async function saveTeacher(t: Teacher): Promise<void> {
  await kvSet(keys.teacher(t.id), t);
}

export async function ensureTeacher(
  userId: number,
  chatId: number,
  defaults?: Partial<Pick<Teacher, "name" | "bio" | "timezone">>,
): Promise<Teacher> {
  const id = String(userId);
  const existing = await getTeacher(id);
  if (existing) {
    if (existing.chatId !== chatId) {
      existing.chatId = chatId;
      await saveTeacher(existing);
    }
    return existing;
  }
  const t: Teacher = {
    id,
    name: defaults?.name ?? "",
    bio: defaults?.bio ?? "",
    timezone: defaults?.timezone ?? "UTC",
    courseIds: [],
    chatId,
    createdAt: now().toISOString(),
  };
  await saveTeacher(t);
  return t;
}

export function teacherProfileComplete(t: Teacher): boolean {
  return Boolean(t.name && t.timezone);
}

// ─── Student ───────────────────────────────────────────────────────────────

export async function getStudent(id: string): Promise<Student | undefined> {
  return kvGet<Student>(keys.student(id));
}

export async function saveStudent(s: Student): Promise<void> {
  await kvSet(keys.student(s.id), s);
}

export async function ensureStudent(
  userId: number,
  chatId: number,
  defaults?: Partial<Pick<Student, "name" | "timezone">>,
): Promise<Student> {
  const id = String(userId);
  const existing = await getStudent(id);
  if (existing) {
    if (existing.chatId !== chatId) {
      existing.chatId = chatId;
      await saveStudent(existing);
    }
    return existing;
  }
  const s: Student = {
    id,
    name: defaults?.name ?? "",
    enrollmentIds: [],
    chatId,
    timezone: defaults?.timezone ?? "UTC",
    createdAt: now().toISOString(),
  };
  await saveStudent(s);
  return s;
}

export function studentProfileComplete(s: Student): boolean {
  return Boolean(s.name);
}

// ─── Course catalog index ──────────────────────────────────────────────────

async function getCourseIndex(): Promise<CourseIndex> {
  return (await kvGet<CourseIndex>(keys.courseIndex())) ?? { ids: [] };
}

async function saveCourseIndex(idx: CourseIndex): Promise<void> {
  await kvSet(keys.courseIndex(), idx);
}

export async function listCourseIds(): Promise<string[]> {
  return (await getCourseIndex()).ids;
}

export async function getCourse(id: string): Promise<Course | undefined> {
  return kvGet<Course>(keys.course(id));
}

export async function saveCourse(c: Course): Promise<void> {
  await kvSet(keys.course(c.id), c);
}

export async function createCourse(input: {
  teacherId: string;
  title: string;
  price: number;
  currency?: string;
  description?: string;
}): Promise<Course> {
  const course: Course = {
    id: shortId("c"),
    teacherId: input.teacherId,
    title: input.title.trim(),
    price: input.price,
    currency: input.currency ?? "USD",
    sessionIds: [],
    description: input.description?.trim() ?? "",
    createdAt: now().toISOString(),
    active: true,
  };
  await saveCourse(course);

  const idx = await getCourseIndex();
  if (!idx.ids.includes(course.id)) {
    idx.ids.push(course.id);
    await saveCourseIndex(idx);
  }

  const teacher = await getTeacher(input.teacherId);
  if (teacher && !teacher.courseIds.includes(course.id)) {
    teacher.courseIds.push(course.id);
    await saveTeacher(teacher);
  }

  return course;
}

export async function listActiveCourses(): Promise<Course[]> {
  const ids = await listCourseIds();
  const out: Course[] = [];
  for (const id of ids) {
    const c = await getCourse(id);
    if (c && c.active) out.push(c);
  }
  return out;
}

// ─── Sessions ──────────────────────────────────────────────────────────────

export async function getSession(id: string): Promise<Session | undefined> {
  return kvGet<Session>(keys.session(id));
}

export async function saveSession(s: Session): Promise<void> {
  await kvSet(keys.session(s.id), s);
}

export async function createSession(input: {
  courseId: string;
  teacherId: string;
  startTime: string;
  capacity: number;
  joinUrl: string;
}): Promise<Session> {
  const session: Session = {
    id: shortId("s"),
    courseId: input.courseId,
    teacherId: input.teacherId,
    startTime: input.startTime,
    capacity: Math.max(1, Math.floor(input.capacity)),
    enrolledIds: [],
    waitingList: [],
    joinUrl: input.joinUrl.trim(),
    status: "scheduled",
    payoutStatus: "none",
  };
  await saveSession(session);

  const course = await getCourse(input.courseId);
  if (course && !course.sessionIds.includes(session.id)) {
    course.sessionIds.push(session.id);
    await saveCourse(course);
  }

  return session;
}

export async function listSessionsForCourse(courseId: string): Promise<Session[]> {
  const course = await getCourse(courseId);
  if (!course) return [];
  const out: Session[] = [];
  for (const id of course.sessionIds) {
    const s = await getSession(id);
    if (s) out.push(s);
  }
  return out;
}

export function sessionSpotsLeft(s: Session): number {
  if (s.status !== "scheduled") return 0;
  return Math.max(0, s.capacity - s.enrolledIds.length);
}

// ─── Enrollments ───────────────────────────────────────────────────────────

export async function getEnrollment(id: string): Promise<Enrollment | undefined> {
  return kvGet<Enrollment>(keys.enrollment(id));
}

export async function saveEnrollment(e: Enrollment): Promise<void> {
  await kvSet(keys.enrollment(e.id), e);
}

export async function createEnrollment(input: {
  studentId: string;
  courseId: string;
  sessionIds: string[];
  paymentId: string;
  paymentStatus: Enrollment["paymentStatus"];
  status: Enrollment["status"];
}): Promise<Enrollment> {
  const e: Enrollment = {
    id: shortId("e"),
    studentId: input.studentId,
    courseId: input.courseId,
    sessionIds: [...input.sessionIds],
    paymentId: input.paymentId,
    paymentStatus: input.paymentStatus,
    status: input.status,
    createdAt: now().toISOString(),
  };
  await saveEnrollment(e);

  const student = await getStudent(input.studentId);
  if (student && !student.enrollmentIds.includes(e.id)) {
    student.enrollmentIds.push(e.id);
    await saveStudent(student);
  }

  return e;
}

export async function listEnrollmentsForStudent(
  studentId: string,
): Promise<Enrollment[]> {
  const student = await getStudent(studentId);
  if (!student) return [];
  const out: Enrollment[] = [];
  for (const id of student.enrollmentIds) {
    const e = await getEnrollment(id);
    if (e) out.push(e);
  }
  return out;
}

// ─── Payments ──────────────────────────────────────────────────────────────

export async function getPayment(id: string): Promise<Payment | undefined> {
  return kvGet<Payment>(keys.payment(id));
}

export async function savePayment(p: Payment): Promise<void> {
  await kvSet(keys.payment(p.id), p);
}

export async function createPaymentRecord(input: {
  amount: number;
  currency: string;
  studentId: string;
  courseId: string;
  sessionId: string;
  enrollmentId: string;
  status: Payment["status"];
  providerRef: string;
}): Promise<Payment> {
  const p: Payment = {
    id: shortId("p"),
    amount: input.amount,
    currency: input.currency,
    studentId: input.studentId,
    courseId: input.courseId,
    sessionId: input.sessionId,
    enrollmentId: input.enrollmentId,
    refundStatus: "none",
    status: input.status,
    providerRef: input.providerRef,
    createdAt: now().toISOString(),
  };
  await savePayment(p);
  return p;
}

// ─── Reminders ─────────────────────────────────────────────────────────────

async function getReminderIndex(): Promise<ReminderIndex> {
  return (await kvGet<ReminderIndex>(keys.reminderIndex())) ?? { ids: [] };
}

async function saveReminderIndex(idx: ReminderIndex): Promise<void> {
  await kvSet(keys.reminderIndex(), idx);
}

export async function getReminder(id: string): Promise<Reminder | undefined> {
  return kvGet<Reminder>(keys.reminder(id));
}

export async function saveReminder(r: Reminder): Promise<void> {
  await kvSet(keys.reminder(r.id), r);
}

export async function scheduleReminder(input: Omit<Reminder, "id" | "sent">): Promise<Reminder> {
  const r: Reminder = { ...input, id: shortId("r"), sent: false };
  await saveReminder(r);
  const idx = await getReminderIndex();
  if (!idx.ids.includes(r.id)) {
    idx.ids.push(r.id);
    await saveReminderIndex(idx);
  }
  return r;
}

export async function listPendingReminderIds(): Promise<string[]> {
  return (await getReminderIndex()).ids;
}

// ─── Promotion lock (concurrent waiting-list safety) ───────────────────────

export async function tryAcquirePromoLock(sessionId: string): Promise<boolean> {
  const k = keys.promoLock(sessionId);
  const existing = await kvGet<{ held: boolean; at: string }>(k);
  if (existing?.held) {
    // Stale lock > 15s is released (covers crashed handlers)
    const age = now().getTime() - new Date(existing.at).getTime();
    if (age < 15_000) return false;
  }
  await kvSet(k, { held: true, at: now().toISOString() });
  return true;
}

export async function releasePromoLock(sessionId: string): Promise<void> {
  await kvSet(keys.promoLock(sessionId), { held: false, at: now().toISOString() });
}
