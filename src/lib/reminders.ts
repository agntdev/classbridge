/**
 * Fire due session reminders. Called from a lightweight middleware on each
 * update so reminders work without a separate cron process (and stay testable
 * via the injectable clock).
 */

import { now } from "./clock.js";
import {
  getReminder,
  listPendingReminderIds,
  saveReminder,
} from "../store/repo.js";
import { safeApiSend } from "./notify.js";

let lastSweepMs = 0;
const SWEEP_EVERY_MS = 5_000;

export async function sweepDueReminders(api: {
  sendMessage: (chatId: number, text: string) => Promise<unknown>;
}): Promise<number> {
  const t = now().getTime();
  // Throttle sweeps so we don't re-read the index on every callback
  if (t - lastSweepMs < SWEEP_EVERY_MS) return 0;
  lastSweepMs = t;

  const ids = await listPendingReminderIds();
  let sent = 0;
  for (const id of ids) {
    const r = await getReminder(id);
    if (!r || r.sent) continue;
    if (new Date(r.fireAt).getTime() > t) continue;
    await safeApiSend(api, r.chatId, r.text);
    r.sent = true;
    await saveReminder(r);
    sent++;
  }
  return sent;
}

/** Test helper — force the next sweep to run. */
export function resetReminderSweepThrottle(): void {
  lastSweepMs = 0;
}
