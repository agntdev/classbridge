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
  listActiveCourses,
  getCourse,
  getTeacher,
  listSessionsForCourse,
  getSession,
  getStudent,
  createEnrollment,
  listEnrollmentsForStudent,
  saveEnrollment,
  sessionSpotsLeft,
} from "../store/repo.js";
import {
  formatInTimezone,
  formatPrice,
} from "../lib/time.js";
import {
  processEnrollmentPayment,
  paymentSuccessMessage,
} from "../lib/payments.js";
import { joinWaitingList } from "../lib/waiting-list.js";
import { backToMenuKeyboard, clearFlow } from "../lib/ui.js";

registerMainMenuItem({
  label: "Browse courses",
  data: "student:browse_courses",
  order: 10,
});

const composer = new Composer<Ctx>();

async function requireStudent(ctx: Ctx) {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  if (!userId || !chatId) return null;
  return ensureStudent(userId, chatId);
}

composer.callbackQuery("student:browse_courses", async (ctx) => {
  await ctx.answerCallbackQuery();
  clearFlow(ctx.session);
  ctx.session.role = "student";

  const student = await requireStudent(ctx);
  if (!student) {
    await ctx.reply("Open CourseConnect in a private chat to browse courses.");
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

  const courses = await listActiveCourses();
  // Only show courses that still have at least one scheduled session
  const withSessions: Array<{ course: Awaited<ReturnType<typeof getCourse>>; label: string }> = [];
  for (const c of courses) {
    const sessions = await listSessionsForCourse(c.id);
    const upcoming = sessions.filter((s) => s.status === "scheduled");
    if (upcoming.length === 0) continue;
    const teacher = await getTeacher(c.teacherId);
    withSessions.push({
      course: c,
      label: `${c.title} · ${formatPrice(c.price, c.currency)}${teacher?.name ? " · " + teacher.name : ""}`.slice(0, 60),
    });
  }

  if (withSessions.length === 0) {
    const msg =
      "No courses are open right now. Check back soon — or teach one yourself.";
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

  const rows = withSessions.map((w) => [
    inlineButton(w.label, `scourse:${w.course!.id}`),
  ]);
  rows.push([inlineButton("Back to menu", "menu:main")]);

  const msg =
    "Available courses — tap one to see sessions, price, and open seats.";
  try {
    await ctx.editMessageText(msg, { reply_markup: inlineKeyboard(rows) });
  } catch {
    await ctx.reply(msg, { reply_markup: inlineKeyboard(rows) });
  }
});

composer.callbackQuery(/^scourse:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const courseId = ctx.match![1]!;
  const student = await requireStudent(ctx);
  if (!student) return;

  const course = await getCourse(courseId);
  if (!course || !course.active) {
    await ctx.editMessageText("That course isn't available anymore.", {
      reply_markup: inlineKeyboard([
        [inlineButton("Browse courses", "student:browse_courses")],
      ]),
    });
    return;
  }

  const teacher = await getTeacher(course.teacherId);
  const sessions = (await listSessionsForCourse(courseId)).filter(
    (s) => s.status === "scheduled",
  );
  const tz = student.timezone || teacher?.timezone || "UTC";

  const lines = [
    course.title,
    teacher?.name ? `Teacher: ${teacher.name}` : "",
    teacher?.bio ? teacher.bio : "",
    `Price: ${formatPrice(course.price, course.currency)} (one-time)`,
    course.description ? `\n${course.description}` : "",
    "",
    "Sessions:",
  ].filter((l) => l !== "");

  const rows = [];
  for (const s of sessions) {
    const when = formatInTimezone(s.startTime, tz);
    const open = sessionSpotsLeft(s);
    const seat =
      open > 0
        ? `${open} seat${open === 1 ? "" : "s"} open`
        : `full · ${s.waitingList.length} waiting`;
    lines.push(`• ${when} — ${seat}`);
    rows.push([
      inlineButton(
        `${when} (${open > 0 ? open + " open" : "waitlist"})`.slice(0, 60),
        `ssess:${s.id}`,
      ),
    ]);
  }
  rows.push([inlineButton("Back", "student:browse_courses")]);

  await ctx.editMessageText(lines.join("\n"), {
    reply_markup: inlineKeyboard(rows),
  });
});

composer.callbackQuery(/^ssess:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const sessionId = ctx.match![1]!;
  const student = await requireStudent(ctx);
  if (!student) return;

  const session = await getSession(sessionId);
  if (!session || session.status !== "scheduled") {
    await ctx.editMessageText("That session isn't available.", {
      reply_markup: inlineKeyboard([
        [inlineButton("Browse courses", "student:browse_courses")],
      ]),
    });
    return;
  }

  const course = await getCourse(session.courseId);
  if (!course) {
    await ctx.editMessageText("That course isn't available anymore.", {
      reply_markup: backToMenuKeyboard(),
    });
    return;
  }

  const tz = student.timezone || "UTC";
  const when = formatInTimezone(session.startTime, tz);
  const open = sessionSpotsLeft(session);
  const alreadyIn = session.enrolledIds.includes(student.id);
  const onWait = session.waitingList.includes(student.id);

  let body =
    `${course.title}\n` +
    `Session: ${when}\n` +
    `Price: ${formatPrice(course.price, course.currency)}\n` +
    `Seats: ${session.enrolledIds.length}/${session.capacity}`;

  const rows = [];

  if (alreadyIn) {
    body += "\n\nYou're enrolled. Find your join link under My enrollments.";
    rows.push([inlineButton("My enrollments", "student:my_enrollments")]);
  } else if (onWait) {
    const pos = session.waitingList.indexOf(student.id) + 1;
    body += `\n\nYou're #${pos} on the waiting list. We'll enroll you automatically if a seat opens.`;
  } else if (open > 0) {
    body +=
      `\n\n${open} seat${open === 1 ? "" : "s"} left. Pay once to enroll and get the join link.`;
    rows.push([
      inlineButton(
        `Pay ${formatPrice(course.price, course.currency)} & enroll`,
        `pay:${session.id}`,
      ),
    ]);
  } else {
    body +=
      `\n\nThis session is full (${session.waitingList.length} on the waiting list). Join the list for first-come, first-served promotion.`;
    rows.push([inlineButton("Join waiting list", `wait:${session.id}`)]);
  }

  rows.push([inlineButton("Back", `scourse:${course.id}`)]);

  await ctx.editMessageText(body, { reply_markup: inlineKeyboard(rows) });
});

composer.callbackQuery(/^pay:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Processing payment…" });
  const sessionId = ctx.match![1]!;
  const student = await requireStudent(ctx);
  if (!student || !studentProfileComplete(student)) {
    await ctx.editMessageText("Finish your student profile first.", {
      reply_markup: inlineKeyboard([
        [inlineButton("Set up profile", "role:student")],
      ]),
    });
    return;
  }

  const session = await getSession(sessionId);
  if (!session) {
    await ctx.editMessageText("That session couldn't be found.", {
      reply_markup: backToMenuKeyboard(),
    });
    return;
  }

  const result = await processEnrollmentPayment({
    studentId: student.id,
    courseId: session.courseId,
    sessionId: session.id,
  });

  if (!result.ok) {
    const rows = [];
    if (result.reason.includes("waiting list")) {
      rows.push([inlineButton("Join waiting list", `wait:${sessionId}`)]);
    }
    rows.push([inlineButton("Browse courses", "student:browse_courses")]);
    await ctx.editMessageText(result.reason, {
      reply_markup: inlineKeyboard(rows),
    });
    return;
  }

  const course = await getCourse(session.courseId);
  const freshStudent = (await getStudent(student.id)) ?? student;
  const msg = paymentSuccessMessage({
    courseTitle: course?.title ?? "your course",
    amount: result.payment.amount,
    currency: result.payment.currency,
    startTime: result.session.startTime,
    timezone: freshStudent.timezone,
    joinUrl: result.joinUrl,
  });

  await ctx.editMessageText(msg, {
    reply_markup: inlineKeyboard([
      [inlineButton("My enrollments", "student:my_enrollments")],
      [inlineButton("Back to menu", "menu:main")],
    ]),
  });
});

composer.callbackQuery(/^wait:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const sessionId = ctx.match![1]!;
  const student = await requireStudent(ctx);
  if (!student || !studentProfileComplete(student)) {
    await ctx.editMessageText("Finish your student profile first.", {
      reply_markup: inlineKeyboard([
        [inlineButton("Set up profile", "role:student")],
      ]),
    });
    return;
  }

  const session = await getSession(sessionId);
  if (!session) {
    await ctx.editMessageText("That session couldn't be found.", {
      reply_markup: backToMenuKeyboard(),
    });
    return;
  }

  const result = await joinWaitingList(sessionId, student.id);
  if (!result.ok) {
    await ctx.editMessageText(result.reason, {
      reply_markup: inlineKeyboard([
        [inlineButton("View session", `ssess:${sessionId}`)],
        [inlineButton("Browse courses", "student:browse_courses")],
      ]),
    });
    return;
  }

  // Track waitlist membership as an enrollment so it shows under My enrollments
  const existing = await listEnrollmentsForStudent(student.id);
  const already = existing.find(
    (e) =>
      e.sessionIds.includes(sessionId) &&
      (e.status === "waitlisted" || e.status === "active"),
  );
  if (!already) {
    await createEnrollment({
      studentId: student.id,
      courseId: session.courseId,
      sessionIds: [sessionId],
      paymentId: "",
      paymentStatus: "pending",
      status: "waitlisted",
    });
  } else if (already.status !== "active") {
    already.status = "waitlisted";
    await saveEnrollment(already);
  }

  await ctx.editMessageText(
    `You're on the waiting list — position #${result.position}.\n\n` +
      `If a seat opens, we'll enroll you automatically, charge the course fee, and send your join link here.`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("My enrollments", "student:my_enrollments")],
        [inlineButton("Browse courses", "student:browse_courses")],
        [inlineButton("Back to menu", "menu:main")],
      ]),
    },
  );
});

export default composer;
