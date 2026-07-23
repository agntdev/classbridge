import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  registerMainMenuItem,
  inlineButton,
  inlineKeyboard,
} from "../toolkit/index.js";
import {
  ensureTeacher,
  teacherProfileComplete,
  getCourse,
  getSession,
  listSessionsForCourse,
  saveSession,
  getStudent,
  getTeacher,
  listEnrollmentsForStudent,
  saveEnrollment,
} from "../store/repo.js";
import { formatInTimezone, formatPrice } from "../lib/time.js";
import { processRefund } from "../lib/payments.js";
import { promoteUntilFull } from "../lib/waiting-list.js";
import { safeSendMessage } from "../lib/notify.js";
import { backToMenuKeyboard, clearFlow } from "../lib/ui.js";
import { now } from "../lib/clock.js";

registerMainMenuItem({
  label: "Manage sessions",
  data: "teacher:manage_sessions",
  order: 40,
});

const composer = new Composer<Ctx>();

async function requireTeacher(ctx: Ctx) {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  if (!userId || !chatId) return null;
  return ensureTeacher(userId, chatId);
}

composer.callbackQuery("teacher:manage_sessions", async (ctx) => {
  await ctx.answerCallbackQuery();
  clearFlow(ctx.session);
  ctx.session.role = "teacher";

  const teacher = await requireTeacher(ctx);
  if (!teacher) {
    await ctx.reply("Open CourseConnect in a private chat to manage sessions.");
    return;
  }

  if (!teacherProfileComplete(teacher)) {
    const msg =
      "Finish your teacher profile first, then you can manage sessions.";
    const kb = inlineKeyboard([
      [inlineButton("Set up profile", "role:teacher")],
      [inlineButton("Back to menu", "menu:main")],
    ]);
    try {
      await ctx.editMessageText(msg, { reply_markup: kb });
    } catch {
      await ctx.reply(msg, { reply_markup: kb });
    }
    return;
  }

  // Re-read for latest courseIds
  const fresh = (await getTeacher(teacher.id)) ?? teacher;
  if (fresh.courseIds.length === 0) {
    const msg =
      "You don't have any courses yet — tap Create course to publish your first one.";
    const kb = inlineKeyboard([
      [inlineButton("Create course", "teacher:create_course")],
      [inlineButton("Back to menu", "menu:main")],
    ]);
    try {
      await ctx.editMessageText(msg, { reply_markup: kb });
    } catch {
      await ctx.reply(msg, { reply_markup: kb });
    }
    return;
  }

  const rows = [];
  for (const cid of fresh.courseIds) {
    const c = await getCourse(cid);
    if (!c) continue;
    rows.push([
      inlineButton(
        `${c.active ? "" : "(off) "}${c.title}`.slice(0, 40),
        `tcourse:${c.id}`,
      ),
    ]);
  }
  rows.push([inlineButton("Back to menu", "menu:main")]);

  const msg = "Your courses — pick one to manage sessions, capacity, and waiting lists.";
  try {
    await ctx.editMessageText(msg, { reply_markup: inlineKeyboard(rows) });
  } catch {
    await ctx.reply(msg, { reply_markup: inlineKeyboard(rows) });
  }
});

composer.callbackQuery(/^tcourse:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const courseId = ctx.match![1]!;
  const teacher = await requireTeacher(ctx);
  if (!teacher) return;

  const course = await getCourse(courseId);
  if (!course || course.teacherId !== teacher.id) {
    await ctx.editMessageText("That course isn't yours or no longer exists.", {
      reply_markup: backToMenuKeyboard(),
    });
    return;
  }

  const sessions = await listSessionsForCourse(courseId);
  if (sessions.length === 0) {
    await ctx.editMessageText(
      `${course.title} has no sessions yet. Create a new course run to add one.`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("Create course", "teacher:create_course")],
          [inlineButton("Back", "teacher:manage_sessions")],
        ]),
      },
    );
    return;
  }

  const lines = [
    `${course.title} — ${formatPrice(course.price, course.currency)}`,
    course.description ? course.description : "",
    "",
    "Sessions:",
  ].filter(Boolean);

  const rows = [];
  for (const s of sessions) {
    const when = formatInTimezone(s.startTime, teacher.timezone);
    const spots = Math.max(0, s.capacity - s.enrolledIds.length);
    const status =
      s.status === "cancelled"
        ? "cancelled"
        : s.status === "completed"
          ? "done"
          : `${s.enrolledIds.length}/${s.capacity} enrolled, ${s.waitingList.length} waiting`;
    lines.push(`• ${when} — ${status}`);
    rows.push([
      inlineButton(
        `${s.status === "scheduled" ? "" : "[" + s.status + "] "}${when}`.slice(0, 40),
        `tsess:${s.id}`,
      ),
    ]);
  }
  rows.push([inlineButton("Back", "teacher:manage_sessions")]);

  await ctx.editMessageText(lines.join("\n"), {
    reply_markup: inlineKeyboard(rows),
  });
});

composer.callbackQuery(/^tsess:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const sessionId = ctx.match![1]!;
  const teacher = await requireTeacher(ctx);
  if (!teacher) return;

  const session = await getSession(sessionId);
  if (!session || session.teacherId !== teacher.id) {
    await ctx.editMessageText("That session couldn't be found.", {
      reply_markup: backToMenuKeyboard(),
    });
    return;
  }
  const course = await getCourse(session.courseId);
  const when = formatInTimezone(session.startTime, teacher.timezone);
  const spots = Math.max(0, session.capacity - session.enrolledIds.length);

  const waitNames: string[] = [];
  for (const sid of session.waitingList.slice(0, 5)) {
    const st = await getStudent(sid);
    waitNames.push(st?.name || "Student");
  }

  const text =
    `${course?.title ?? "Course"}\n` +
    `When: ${when}\n` +
    `Status: ${session.status}\n` +
    `Capacity: ${session.capacity} (${session.enrolledIds.length} enrolled, ${spots} open)\n` +
    `Waiting list: ${session.waitingList.length}` +
    (waitNames.length ? ` (${waitNames.join(", ")}${session.waitingList.length > 5 ? "…" : ""})` : "") +
    `\nJoin link: ${session.joinUrl}` +
    (session.payoutStatus === "paid_out" ? "\nPayout: sent to you" : "");

  const rows = [];
  if (session.status === "scheduled") {
    rows.push([inlineButton("Edit capacity", `cap:ask:${session.id}`)]);
    rows.push([inlineButton("Cancel session", `scancel:ask:${session.id}`)]);
    if (new Date(session.startTime).getTime() <= now().getTime()) {
      rows.push([inlineButton("Mark complete", `scomplete:${session.id}`)]);
    }
  }
  rows.push([inlineButton("Back", `tcourse:${session.courseId}`)]);

  await ctx.editMessageText(text, { reply_markup: inlineKeyboard(rows) });
});

composer.callbackQuery(/^cap:ask:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const sessionId = ctx.match![1]!;
  ctx.session.step = "session:capacity";
  ctx.session.draft = { sessionId };
  await ctx.editMessageText(
    "Send the new capacity as a whole number (must be at least the number already enrolled).",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("Cancel", `tsess:${sessionId}`)],
      ]),
    },
  );
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "session:capacity") return next();
  const sessionId = ctx.session.draft?.sessionId;
  if (!sessionId) {
    clearFlow(ctx.session);
    return next();
  }

  const teacher = await requireTeacher(ctx);
  if (!teacher) return;

  const session = await getSession(sessionId);
  if (!session || session.teacherId !== teacher.id) {
    clearFlow(ctx.session);
    await ctx.reply("That session couldn't be found.", {
      reply_markup: backToMenuKeyboard(),
    });
    return;
  }

  const cap = Number(ctx.message.text.trim());
  if (!Number.isInteger(cap) || cap < 1 || cap > 500) {
    await ctx.reply("Enter a whole number between 1 and 500.");
    return;
  }
  if (cap < session.enrolledIds.length) {
    await ctx.reply(
      `You already have ${session.enrolledIds.length} enrolled. Capacity can't go below that.`,
    );
    return;
  }

  const oldCap = session.capacity;
  session.capacity = cap;
  await saveSession(session);
  clearFlow(ctx.session);

  // If capacity grew, promote from waiting list
  let promoNote = "";
  if (cap > oldCap) {
    const notices = await promoteUntilFull(session.id);
    for (const n of notices) {
      await safeSendMessage(ctx, n.chatId, n.message);
    }
    if (notices.length) {
      promoNote = `\n\nPromoted ${notices.length} student${notices.length === 1 ? "" : "s"} from the waiting list.`;
    }
  }

  await ctx.reply(
    `Capacity updated to ${cap}.${promoNote}`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("View session", `tsess:${session.id}`)],
        [inlineButton("Back to menu", "menu:main")],
      ]),
    },
  );
});

composer.callbackQuery(/^scancel:ask:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const sessionId = ctx.match![1]!;
  await ctx.editMessageText(
    "Cancel this session? Enrolled students will be refunded and notified. Waiting-list spots will be cleared.",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("Yes, cancel session", `scancel:yes:${sessionId}`)],
        [inlineButton("Keep session", `tsess:${sessionId}`)],
      ]),
    },
  );
});

composer.callbackQuery(/^scancel:yes:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const sessionId = ctx.match![1]!;
  const teacher = await requireTeacher(ctx);
  if (!teacher) return;

  const session = await getSession(sessionId);
  if (!session || session.teacherId !== teacher.id) {
    await ctx.editMessageText("That session couldn't be found.", {
      reply_markup: backToMenuKeyboard(),
    });
    return;
  }
  if (session.status === "cancelled") {
    await ctx.editMessageText("This session is already cancelled.", {
      reply_markup: inlineKeyboard([
        [inlineButton("Back", `tcourse:${session.courseId}`)],
      ]),
    });
    return;
  }

  const course = await getCourse(session.courseId);
  const enrolled = [...session.enrolledIds];
  const waiting = [...session.waitingList];

  session.status = "cancelled";
  session.enrolledIds = [];
  session.waitingList = [];
  await saveSession(session);

  // Refund each enrolled student and notify
  for (const studentId of enrolled) {
    const student = await getStudent(studentId);
    const enrollments = await listEnrollmentsForStudent(studentId);
    for (const e of enrollments) {
      if (
        e.status === "active" &&
        e.sessionIds.includes(sessionId) &&
        e.paymentStatus === "paid"
      ) {
        const refund = await processRefund({ enrollmentId: e.id });
        const amount = refund.ok ? refund.payment.amount : course?.price ?? 0;
        const currency = refund.ok
          ? refund.payment.currency
          : course?.currency ?? "USD";
        if (student?.chatId) {
          await safeSendMessage(
            ctx,
            student.chatId,
            `Your session for ${course?.title ?? "a course"} was cancelled by the teacher.\n\n` +
              `A refund of ${formatPrice(amount, currency)} is on the way. We're sorry for the change.`,
          );
        }
      } else if (e.sessionIds.includes(sessionId) && e.status === "active") {
        e.status = "cancelled";
        await saveEnrollment(e);
      }
    }
  }

  // Notify waitlisted students (no charge)
  for (const studentId of waiting) {
    const student = await getStudent(studentId);
    if (student?.chatId) {
      await safeSendMessage(
        ctx,
        student.chatId,
        `A session you were waitlisted for (${course?.title ?? "course"}) was cancelled. You're off the list — no charge was made.`,
      );
    }
  }

  await ctx.editMessageText(
    `Session cancelled. ${enrolled.length} student${enrolled.length === 1 ? "" : "s"} refunded` +
      (waiting.length ? `, ${waiting.length} waitlisted notified` : "") +
      ".",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("Back to courses", "teacher:manage_sessions")],
        [inlineButton("Back to menu", "menu:main")],
      ]),
    },
  );
});

composer.callbackQuery(/^scomplete:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const sessionId = ctx.match![1]!;
  const teacher = await requireTeacher(ctx);
  if (!teacher) return;

  const session = await getSession(sessionId);
  if (!session || session.teacherId !== teacher.id) {
    await ctx.editMessageText("That session couldn't be found.", {
      reply_markup: backToMenuKeyboard(),
    });
    return;
  }
  if (session.status !== "scheduled") {
    await ctx.editMessageText(`This session is already ${session.status}.`, {
      reply_markup: inlineKeyboard([
        [inlineButton("Back", `tsess:${session.id}`)],
      ]),
    });
    return;
  }

  session.status = "completed";
  session.payoutStatus = "paid_out";
  await saveSession(session);

  // Mark related enrollments completed
  for (const studentId of session.enrolledIds) {
    const enrollments = await listEnrollmentsForStudent(studentId);
    for (const e of enrollments) {
      if (e.sessionIds.includes(sessionId) && e.status === "active") {
        e.status = "completed";
        await saveEnrollment(e);
      }
    }
  }

  const course = await getCourse(session.courseId);
  const payout = (course?.price ?? 0) * session.enrolledIds.length;

  await ctx.editMessageText(
    `Session marked complete.\n\n` +
      `Teacher payout of ${formatPrice(payout, course?.currency ?? "USD")} ` +
      `for ${session.enrolledIds.length} student${session.enrolledIds.length === 1 ? "" : "s"} is recorded.`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("Back", `tcourse:${session.courseId}`)],
        [inlineButton("Back to menu", "menu:main")],
      ]),
    },
  );
});

export default composer;
