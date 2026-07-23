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
  createCourse,
  createSession,
  getTeacher,
} from "../store/repo.js";
import { parseSessionTime, formatInTimezone, formatPrice } from "../lib/time.js";
import { clearFlow, cancelFlowKeyboard, backToMenuKeyboard } from "../lib/ui.js";

registerMainMenuItem({
  label: "Create course",
  data: "teacher:create_course",
  order: 30,
});

const composer = new Composer<Ctx>();

async function requireTeacher(ctx: Ctx) {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  if (!userId || !chatId) return null;
  return ensureTeacher(userId, chatId);
}

composer.callbackQuery("teacher:create_course", async (ctx) => {
  await ctx.answerCallbackQuery();
  clearFlow(ctx.session);
  ctx.session.role = "teacher";

  const teacher = await requireTeacher(ctx);
  if (!teacher) {
    await ctx.reply("Open CourseConnect in a private chat to create courses.");
    return;
  }

  if (!teacherProfileComplete(teacher)) {
    ctx.session.step = "teacher:name";
    await ctx.editMessageText(
      "Before you create a course, let's finish your teacher profile.\n\nWhat's your name as students should see it?",
      { reply_markup: cancelFlowKeyboard() },
    ).catch(async () => {
      await ctx.reply(
        "Before you create a course, let's finish your teacher profile.\n\nWhat's your name as students should see it?",
        { reply_markup: cancelFlowKeyboard() },
      );
    });
    return;
  }

  ctx.session.step = "course:title";
  ctx.session.draft = {};
  const msg =
    "Let's create a course.\n\nWhat's the course title?";
  try {
    await ctx.editMessageText(msg, { reply_markup: cancelFlowKeyboard() });
  } catch {
    await ctx.reply(msg, { reply_markup: cancelFlowKeyboard() });
  }
});

composer.on("message:text", async (ctx, next) => {
  const step = ctx.session.step;
  if (!step?.startsWith("course:")) return next();

  const text = ctx.message.text.trim();
  const teacher = await requireTeacher(ctx);
  if (!teacher) {
    await ctx.reply("Open CourseConnect in a private chat to create courses.");
    return;
  }
  if (!ctx.session.draft) ctx.session.draft = {};

  if (step === "course:title") {
    if (text.length < 3 || text.length > 80) {
      await ctx.reply("Titles work best between 3 and 80 characters. Try again.");
      return;
    }
    ctx.session.draft.title = text;
    ctx.session.step = "course:description";
    await ctx.reply(
      "Add a short description students will see (or type \"skip\"):",
      { reply_markup: cancelFlowKeyboard() },
    );
    return;
  }

  if (step === "course:description") {
    ctx.session.draft.description =
      text.toLowerCase() === "skip" ? "" : text.slice(0, 500);
    ctx.session.step = "course:price";
    await ctx.reply(
      "What one-time price should students pay? (e.g. 49 or 49.99)",
      { reply_markup: cancelFlowKeyboard() },
    );
    return;
  }

  if (step === "course:price") {
    const price = Number(text.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(price) || price < 0 || price > 100_000) {
      await ctx.reply(
        "Enter a valid price as a number — for example 49 or 49.99.",
      );
      return;
    }
    ctx.session.draft.price = Math.round(price * 100) / 100;
    ctx.session.step = "course:session_time";
    await ctx.reply(
      `Price set to ${formatPrice(ctx.session.draft.price)}.\n\n` +
        `When is the first session?\n` +
        `Use your timezone (${teacher.timezone}):\n` +
        `• YYYY-MM-DD HH:mm  (e.g. 2026-08-01 18:00)\n` +
        `• or full ISO with offset`,
      { reply_markup: cancelFlowKeyboard() },
    );
    return;
  }

  if (step === "course:session_time") {
    const iso = parseSessionTime(text, teacher.timezone);
    if (!iso) {
      await ctx.reply(
        "Couldn't read that time — check the format and make sure it's in the future.\n" +
          "Example: 2026-08-01 18:00",
      );
      return;
    }
    ctx.session.draft.startTime = iso;
    ctx.session.step = "course:capacity";
    await ctx.reply(
      `Session time: ${formatInTimezone(iso, teacher.timezone)}\n\n` +
        "How many students can join this session? (e.g. 10)",
      { reply_markup: cancelFlowKeyboard() },
    );
    return;
  }

  if (step === "course:capacity") {
    const cap = Number(text);
    if (!Number.isInteger(cap) || cap < 1 || cap > 500) {
      await ctx.reply("Enter a whole number between 1 and 500 for capacity.");
      return;
    }
    ctx.session.draft.capacity = cap;
    ctx.session.step = "course:join_url";
    await ctx.reply(
      "Paste the session join link (Zoom, Meet, or any URL students will use):",
      { reply_markup: cancelFlowKeyboard() },
    );
    return;
  }

  if (step === "course:join_url") {
    let url = text;
    if (!/^https?:\/\//i.test(url)) {
      url = "https://" + url;
    }
    try {
      // Validate URL shape
      new URL(url);
    } catch {
      await ctx.reply("That doesn't look like a valid link. Paste a full URL.");
      return;
    }
    ctx.session.draft.joinUrl = url;

    const d = ctx.session.draft;
    const summary =
      `Ready to publish?\n\n` +
      `Course: ${d.title}\n` +
      (d.description ? `About: ${d.description}\n` : "") +
      `Price: ${formatPrice(d.price ?? 0)}\n` +
      `Session: ${formatInTimezone(d.startTime!, teacher.timezone)}\n` +
      `Capacity: ${d.capacity}\n` +
      `Join link: ${d.joinUrl}`;

    ctx.session.step = "course:confirm";
    await ctx.reply(summary, {
      reply_markup: inlineKeyboard([
        [inlineButton("Publish course", "course:publish")],
        [inlineButton("Cancel", "flow:cancel")],
      ]),
    });
    return;
  }

  return next();
});

composer.callbackQuery("course:publish", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.session.step !== "course:confirm" || !ctx.session.draft) {
    await ctx.editMessageText(
      "That draft expired. Tap Create course to start again.",
      { reply_markup: backToMenuKeyboard() },
    );
    return;
  }

  const teacher = await requireTeacher(ctx);
  if (!teacher || !teacherProfileComplete(teacher)) {
    await ctx.editMessageText(
      "Finish your teacher profile first, then create a course.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("Set up profile", "role:teacher")],
          [inlineButton("Back to menu", "menu:main")],
        ]),
      },
    );
    return;
  }

  const d = ctx.session.draft;
  if (
    !d.title ||
    d.price === undefined ||
    !d.startTime ||
    !d.capacity ||
    !d.joinUrl
  ) {
    clearFlow(ctx.session);
    await ctx.editMessageText(
      "Something was missing from the draft. Tap Create course to start again.",
      { reply_markup: backToMenuKeyboard() },
    );
    return;
  }

  const course = await createCourse({
    teacherId: teacher.id,
    title: d.title,
    price: d.price,
    description: d.description,
  });
  const session = await createSession({
    courseId: course.id,
    teacherId: teacher.id,
    startTime: d.startTime,
    capacity: d.capacity,
    joinUrl: d.joinUrl,
  });

  clearFlow(ctx.session);

  // Refresh teacher for course count
  const refreshed = (await getTeacher(teacher.id)) ?? teacher;

  await ctx.editMessageText(
    `Your course is live.\n\n` +
      `${course.title} — ${formatPrice(course.price)}\n` +
      `First session: ${formatInTimezone(session.startTime, refreshed.timezone)}\n` +
      `Capacity: ${session.capacity}\n\n` +
      `Students can find it under Browse courses. You can manage capacity and waiting lists anytime.`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("Manage sessions", "teacher:manage_sessions")],
        [inlineButton("Create another", "teacher:create_course")],
        [inlineButton("Back to menu", "menu:main")],
      ]),
    },
  );
});

export default composer;
