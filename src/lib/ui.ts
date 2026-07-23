/** Shared UI helpers and copy constants for CourseConnect. */

import {
  inlineButton,
  inlineKeyboard,
  type InlineKeyboardMarkup,
} from "../toolkit/index.js";

export const WELCOME =
  "Welcome to CourseConnect.\n\n" +
  "Teach paid online courses or enroll as a student — schedules, payments, join links, and reminders all live here.\n\n" +
  "Tap a button below to get started.";

export const HELP =
  "CourseConnect connects teachers and students for paid online courses.\n\n" +
  "Teachers: create a course, set a price and session times, then manage capacity and waiting lists.\n" +
  "Students: browse courses, pay once to enroll, get your join link, and receive reminders before class.\n\n" +
  "Tap /start to open the menu. Everything is reachable from the buttons — no extra commands to remember.";

export function backToMenuKeyboard(): InlineKeyboardMarkup {
  return inlineKeyboard([[inlineButton("Back to menu", "menu:main")]]);
}

export function cancelFlowKeyboard(): InlineKeyboardMarkup {
  return inlineKeyboard([
    [inlineButton("Cancel", "flow:cancel")],
    [inlineButton("Back to menu", "menu:main")],
  ]);
}

export function clearFlow(session: {
  step?: string;
  draft?: Record<string, unknown>;
}): void {
  session.step = undefined;
  session.draft = undefined;
}
