import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { mainMenuKeyboard, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { WELCOME, clearFlow } from "../lib/ui.js";
import { sweepDueReminders } from "../lib/reminders.js";
import {
  ensureStudent,
  ensureTeacher,
  studentProfileComplete,
  teacherProfileComplete,
  saveTeacher,
  saveStudent,
} from "../store/repo.js";
import { COMMON_TIMEZONES, isValidTimezone } from "../lib/time.js";

const composer = new Composer<Ctx>();

// Fire due reminders on every update (throttled) so 24h/30m notices land
// without a separate cron. Tolerates 403 inside the sweeper.
composer.use(async (ctx, next) => {
  try {
    await sweepDueReminders(ctx.api);
  } catch {
    /* never block the user on reminder IO */
  }
  return next();
});

composer.command("start", async (ctx) => {
  clearFlow(ctx.session);
  const payload = ctx.match?.toString().trim() ?? "";
  // Deep-link invite support: /start join_<code> reserved for future invites
  if (payload.startsWith("join_")) {
    await ctx.reply(
      "Thanks for opening the invite link. Tap a button below to create your profile and continue.",
      { reply_markup: mainMenuKeyboard() },
    );
    return;
  }

  await ctx.reply(WELCOME, {
    reply_markup: mainMenuKeyboard(1),
  });
});

composer.callbackQuery("menu:main", async (ctx) => {
  await ctx.answerCallbackQuery();
  clearFlow(ctx.session);
  await ctx.editMessageText(WELCOME, {
    reply_markup: mainMenuKeyboard(1),
  });
});

composer.callbackQuery("flow:cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  clearFlow(ctx.session);
  await ctx.editMessageText("Cancelled. Nothing was saved.\n\nTap a button below when you're ready.", {
    reply_markup: mainMenuKeyboard(1),
  });
});

// ── Role selection shortcuts from empty teacher/student gates ──────────────

composer.callbackQuery("role:teacher", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.role = "teacher";
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  if (!userId || !chatId) {
    await ctx.reply("Couldn't identify your account. Open the bot from a private chat and try again.");
    return;
  }
  const teacher = await ensureTeacher(userId, chatId);
  if (!teacherProfileComplete(teacher)) {
    ctx.session.step = "teacher:name";
    await ctx.editMessageText(
      "Let's set up your teacher profile.\n\nWhat's your name as students should see it?",
      {
        reply_markup: inlineKeyboard([[inlineButton("Cancel", "flow:cancel")]]),
      },
    );
    return;
  }
  await ctx.editMessageText(
    `Welcome back, ${teacher.name}. Use the menu to create courses or manage sessions.`,
    { reply_markup: mainMenuKeyboard(1) },
  );
});

composer.callbackQuery("role:student", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.role = "student";
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  if (!userId || !chatId) {
    await ctx.reply("Couldn't identify your account. Open the bot from a private chat and try again.");
    return;
  }
  const student = await ensureStudent(userId, chatId);
  if (!studentProfileComplete(student)) {
    ctx.session.step = "student:name";
    await ctx.editMessageText(
      "Let's set up your student profile.\n\nWhat name should teachers see on your enrollments?",
      {
        reply_markup: inlineKeyboard([[inlineButton("Cancel", "flow:cancel")]]),
      },
    );
    return;
  }
  await ctx.editMessageText(
    `Welcome back, ${student.name}. Browse courses or check your enrollments from the menu.`,
    { reply_markup: mainMenuKeyboard(1) },
  );
});

// ── Shared profile text steps ──────────────────────────────────────────────

composer.on("message:text", async (ctx, next) => {
  const step = ctx.session.step;
  if (!step) return next();

  const text = ctx.message.text.trim();
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (!userId || !chatId) return next();

  if (step === "teacher:name") {
    if (text.length < 2 || text.length > 60) {
      await ctx.reply("Use a name between 2 and 60 characters.");
      return;
    }
    const teacher = await ensureTeacher(userId, chatId);
    teacher.name = text;
    await saveTeacher(teacher);
    ctx.session.step = "teacher:bio";
    await ctx.reply(
      `Nice to meet you, ${text}.\n\nAdd a short bio (or type "skip"):`,
      { reply_markup: inlineKeyboard([[inlineButton("Cancel", "flow:cancel")]]) },
    );
    return;
  }

  if (step === "teacher:bio") {
    const teacher = await ensureTeacher(userId, chatId);
    teacher.bio = text.toLowerCase() === "skip" ? "" : text.slice(0, 500);
    await saveTeacher(teacher);
    ctx.session.step = "teacher:timezone";
    const rows = COMMON_TIMEZONES.map((tz) => [
      inlineButton(tz.replace(/_/g, " "), `tz:teacher:${tz}`),
    ]);
    rows.push([inlineButton("Cancel", "flow:cancel")]);
    await ctx.reply(
      "Which timezone should we use for your session times?",
      { reply_markup: inlineKeyboard(rows) },
    );
    return;
  }

  if (step === "student:name") {
    if (text.length < 2 || text.length > 60) {
      await ctx.reply("Use a name between 2 and 60 characters.");
      return;
    }
    const student = await ensureStudent(userId, chatId);
    student.name = text;
    await saveStudent(student);
    ctx.session.step = "student:timezone";
    const rows = COMMON_TIMEZONES.map((tz) => [
      inlineButton(tz.replace(/_/g, " "), `tz:student:${tz}`),
    ]);
    rows.push([inlineButton("Cancel", "flow:cancel")]);
    await ctx.reply(
      "Got it. Which timezone should we use for reminders and session times?",
      { reply_markup: inlineKeyboard(rows) },
    );
    return;
  }

  return next();
});

composer.callbackQuery(/^tz:(teacher|student):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const role = ctx.match![1] as "teacher" | "student";
  const tz = ctx.match![2]!;
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  if (!userId || !chatId) return;

  if (!isValidTimezone(tz)) {
    await ctx.editMessageText(
      "That timezone isn't supported. Pick one from the list.",
      {
        reply_markup: inlineKeyboard(
          COMMON_TIMEZONES.map((t) => [
            inlineButton(t.replace(/_/g, " "), `tz:${role}:${t}`),
          ]),
        ),
      },
    );
    return;
  }

  if (role === "teacher") {
    const teacher = await ensureTeacher(userId, chatId);
    teacher.timezone = tz;
    await saveTeacher(teacher);
    ctx.session.step = undefined;
    ctx.session.role = "teacher";
    await ctx.editMessageText(
      `You're all set, ${teacher.name}.\n\nTimezone: ${tz}\n\nTap Create course to publish your first class.`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("Create course", "teacher:create_course")],
          [inlineButton("Back to menu", "menu:main")],
        ]),
      },
    );
    return;
  }

  const student = await ensureStudent(userId, chatId);
  student.timezone = tz;
  await saveStudent(student);
  ctx.session.step = undefined;
  ctx.session.role = "student";
  await ctx.editMessageText(
    `You're all set, ${student.name}.\n\nTimezone: ${tz}\n\nBrowse open courses whenever you're ready.`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("Browse courses", "student:browse_courses")],
        [inlineButton("Back to menu", "menu:main")],
      ]),
    },
  );
});

export default composer;
