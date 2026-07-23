/** Durable domain entities for CourseConnect. */

export type PaymentStatus = "pending" | "paid" | "failed" | "refunded";
export type RefundStatus = "none" | "pending" | "refunded" | "failed";
export type EnrollmentStatus = "active" | "waitlisted" | "cancelled" | "completed";
export type SessionStatus = "scheduled" | "cancelled" | "completed";

export interface Teacher {
  id: string; // telegram user id as string
  name: string;
  bio: string;
  timezone: string;
  courseIds: string[]; // index
  chatId: number; // for DMs / notifications
  createdAt: string;
}

export interface Student {
  id: string; // telegram user id as string
  name: string;
  enrollmentIds: string[]; // index
  chatId: number;
  timezone: string;
  createdAt: string;
}

export interface Course {
  id: string;
  teacherId: string;
  title: string;
  price: number; // major currency units (e.g. 49.99)
  currency: string;
  sessionIds: string[]; // index
  description: string;
  createdAt: string;
  active: boolean;
}

export interface Session {
  id: string;
  courseId: string;
  teacherId: string;
  startTime: string; // ISO UTC
  capacity: number;
  enrolledIds: string[]; // student ids currently enrolled (paid)
  waitingList: string[]; // student ids FCFS
  joinUrl: string;
  status: SessionStatus;
  payoutStatus: "pending" | "paid_out" | "none";
}

export interface Enrollment {
  id: string;
  studentId: string;
  courseId: string;
  sessionIds: string[];
  paymentId: string;
  paymentStatus: PaymentStatus;
  status: EnrollmentStatus;
  createdAt: string;
}

export interface Payment {
  id: string;
  amount: number;
  currency: string;
  studentId: string;
  courseId: string;
  sessionId: string;
  enrollmentId: string;
  refundStatus: RefundStatus;
  status: PaymentStatus;
  providerRef: string;
  createdAt: string;
  refundedAt?: string;
}

export interface Reminder {
  id: string;
  sessionId: string;
  studentId: string;
  chatId: number;
  fireAt: string; // ISO UTC
  kind: "24h" | "30m";
  sent: boolean;
  text: string;
}

/** Global index of all course ids (catalog). */
export interface CourseIndex {
  ids: string[];
}

/** Global index of pending reminder ids. */
export interface ReminderIndex {
  ids: string[];
}

// Key helpers (explicit — no keyspace scans)
export const keys = {
  teacher: (id: string) => `teacher:${id}`,
  student: (id: string) => `student:${id}`,
  course: (id: string) => `course:${id}`,
  session: (id: string) => `session:${id}`,
  enrollment: (id: string) => `enrollment:${id}`,
  payment: (id: string) => `payment:${id}`,
  reminder: (id: string) => `reminder:${id}`,
  courseIndex: () => `index:courses`,
  reminderIndex: () => `index:reminders`,
  /** Per-session enrollment lock token for concurrent promotions. */
  promoLock: (sessionId: string) => `lock:promo:${sessionId}`,
};
