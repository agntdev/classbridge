import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  registerMainMenuItem,
  inlineButton,
  inlineKeyboard,
} from "../toolkit/index.js";
import {
  ensureStudent,
  studentProfileComplete,
  listEnrollmentsForStudent,
  getEnrollment,
  getCourse,
  getSession,
  getPayment,
  saveSession,
} from "../store/repo.js";
import { formatInTimezone, formatPrice } from "../lib/time.js";
import {
  processRefund,
  refundSuccessMessage,
} from "../lib/payments.js";
import { promoteUntilFull } from "../lib/waiting-list.js";
import { safeSendMessage } from "../lib/notify.js";
import { backToMenuKeyboard, clearFlow } from "../lib/ui.js";

registerMainMenuItem({
  label: "My enrollments",
  data: "student:my_enrollments",
  order: 20,
});

const composer = new Composer<Ctx>();

async function requireStudent(ctx: Ctx) {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  if (!userId || !chatId) return null;
  return ensureStudent(userId, chatId);
}

composer.callbackQuery("student:my_enrollments", async (ctx) => {
  await ctx.answerCallbackQuery();
  clearFlow(ctx.session);
  ctx.session.role = "student";

  const student = await requireStudent(ctx);
  if (!student) {
    await ctx.reply("Open CourseConnect in a private chat to view enrollments.");
    return;
  }

  if (!studentProfileComplete(student)) {
    ctx.session.step = "student:name";
    const msg =
      "Before you enroll, let's set up your student profile.\n\nWhat name should teachers see?";
    const kb = inlineKeyboard([[inlineButton("Cancel", "flow:cancel")]]);
    try {
      await ctx.editMessageText(msg, { reply_markup: kb });
    } catch {
      await ctx.reply(msg, { reply_markup: kb });
    }
    return;
  }

  const enrollments = await listEnrollmentsForStudent(student.id);
  const active = enrollments.filter(
    (e) => e.status === "active" || e.status === "waitlisted",
  );
  const past = enrollments.filter(
    (e) => e.status === "cancelled" || e.status === "completed",
  );

  if (active.length === 0 && past.length === 0) {
    const msg =
      "No enrollments yet — browse courses to find a class and join.";
    const kb = inlineKeyboard([
      [inlineButton("Browse courses", "student:browse_courses")],
      [inlineButton("Back to menu", "menu:main")],
    ]);
    try {
      await ctx.editMessageText(msg, { reply_markup: kb });
    } catch {
      await ctx.reply(msg, { reply_markup: kb });
    }
    return;
  }

  const lines = ["Your enrollments:"];
  const rows = [];

  for (const e of active) {
    const course = await getCourse(e.courseId);
    const title = course?.title ?? "Course";
    const pay =
      e.paymentStatus === "paid"
        ? "paid"
        : e.paymentStatus === "refunded"
          ? "refunded"
          : e.paymentStatus;
    lines.push(`• ${title} (${e.status}, ${pay})`);
    rows.push([
      inlineButton(`${title}`.slice(0, 40), `enroll:${e.id}`),
    ]);
  }

  if (past.length) {
    lines.push("", "Past:");
    for (const e of past.slice(0, 5)) {
      const course = await getCourse(e.courseId);
      lines.push(`• ${course?.title ?? "Course"} — ${e.status}`);
      rows.push([
        inlineButton(
          `${course?.title ?? "Course"} (${e.status})`.slice(0, 40),
          `enroll:${e.id}`,
        ),
      ]);
    }
  }

  rows.push([inlineButton("Browse courses", "student:browse_courses")]);
  rows.push([inlineButton("Back to menu", "menu:main")]);

  const msg = lines.join("\n");
  try {
    await ctx.editMessageText(msg, { reply_markup: inlineKeyboard(rows) });
  } catch {
    await ctx.reply(msg, { reply_markup: inlineKeyboard(rows) });
  }
});

composer.callbackQuery(/^enroll:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const enrollmentId = ctx.match![1]!;
  const student = await requireStudent(ctx);
  if (!student) return;

  const enrollment = await getEnrollment(enrollmentId);
  if (!enrollment || enrollment.studentId !== student.id) {
    await ctx.editMessageText("That enrollment couldn't be found.", {
      reply_markup: backToMenuKeyboard(),
    });
    return;
  }

  const course = await getCourse(enrollment.courseId);
  const payment = enrollment.paymentId
    ? await getPayment(enrollment.paymentId)
    : undefined;
  const tz = student.timezone || "UTC";

  const sessionLines: string[] = [];
  for (const sid of enrollment.sessionIds) {
    const s = await getSession(sid);
    if (!s) continue;
    const when = formatInTimezone(s.startTime, tz);
    sessionLines.push(
      `• ${when} — ${s.status}` +
        (enrollment.status === "active" && s.status === "scheduled"
          ? `\n  Join: ${s.joinUrl}`
          : ""),
    );
  }

  const priceLine = payment
    ? `Payment: ${formatPrice(payment.amount, payment.currency)} — ${payment.status}` +
      (payment.refundStatus === "refunded" ? " (refunded)" : "")
    : `Payment: ${enrollment.paymentStatus}`;

  const text =
    `${course?.title ?? "Course"}\n` +
    `Status: ${enrollment.status}\n` +
    `${priceLine}\n` +
    (sessionLines.length ? `\nSessions:\n${sessionLines.join("\n")}` : "");

  const rows = [];
  if (enrollment.status === "active" && enrollment.paymentStatus === "paid") {
    rows.push([
      inlineButton("Cancel & refund", `cancelen:ask:${enrollment.id}`),
    ]);
  }
  rows.push([inlineButton("Back", "student:my_enrollments")]);

  await ctx.editMessageText(text, { reply_markup: inlineKeyboard(rows) });
});

composer.callbackQuery(/^cancelen:ask:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const enrollmentId = ctx.match![1]!;
  await ctx.editMessageText(
    "Cancel this enrollment? You'll get a full refund and lose your seat (waiting-list students may take it).",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("Yes, cancel & refund", `cancelen:yes:${enrollmentId}`)],
        [inlineButton("Keep enrollment", `enroll:${enrollmentId}`)],
      ]),
    },
  );
});

composer.callbackQuery(/^cancelen:yes:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const enrollmentId = ctx.match![1]!;
  const student = await requireStudent(ctx);
  if (!student) return;

  const enrollment = await getEnrollment(enrollmentId);
  if (!enrollment || enrollment.studentId !== student.id) {
    await ctx.editMessageText("That enrollment couldn't be found.", {
      reply_markup: backToMenuKeyboard(),
    });
    return;
  }
  if (enrollment.status !== "active") {
    await ctx.editMessageText("This enrollment isn't active anymore.", {
      reply_markup: inlineKeyboard([
        [inlineButton("My enrollments", "student:my_enrollments")],
      ]),
    });
    return;
  }

  const course = await getCourse(enrollment.courseId);
  const sessionIds = [...enrollment.sessionIds];

  const refund = await processRefund({ enrollmentId: enrollment.id });
  if (!refund.ok) {
    await ctx.editMessageText(refund.reason, {
      reply_markup: inlineKeyboard([
        [inlineButton("My enrollments", "student:my_enrollments")],
      ]),
    });
    return;
  }

  // Promote waitlisted students into freed seats
  for (const sid of sessionIds) {
    // Ensure student removed from session enrolled list (processRefund does this)
    const session = await getSession(sid);
    if (session) {
      // Also remove from waiting list if present
      if (session.waitingList.includes(student.id)) {
        session.waitingList = session.waitingList.filter((id) => id !== student.id);
        await saveSession(session);
      }
    }
    const notices = await promoteUntilFull(sid);
    for (const n of notices) {
      await safeSendMessage(ctx, n.chatId, n.message);
    }
  }

  const msg = refundSuccessMessage({
    courseTitle: course?.title ?? "your course",
    amount: refund.payment.amount,
    currency: refund.payment.currency,
  });

  await ctx.editMessageText(msg, {
    reply_markup: inlineKeyboard([
      [inlineButton("Browse courses", "student:browse_courses")],
      [inlineButton("My enrollments", "student:my_enrollments")],
      [inlineButton("Back to menu", "menu:main")],
    ]),
  });

});

export default composer;
