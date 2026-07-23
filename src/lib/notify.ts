/**
 * Safe outbound messaging — a Telegram bot can only DM users who have already
 * started it. Cold sendMessage to strangers / blocked users returns 403; we
 * swallow that so a notification loop never aborts mid-batch.
 */

import type { Context } from "grammy";

export async function safeSendMessage(
  ctx: Context,
  chatId: number,
  text: string,
): Promise<boolean> {
  if (!chatId) return false;
  try {
    await ctx.api.sendMessage(chatId, text);
    return true;
  } catch {
    // 403 forbidden / blocked / never started — skip, keep going
    return false;
  }
}

/** Best-effort send without a request context (uses bot.api). */
export async function safeApiSend(
  api: { sendMessage: (chatId: number, text: string) => Promise<unknown> },
  chatId: number,
  text: string,
): Promise<boolean> {
  if (!chatId) return false;
  try {
    await api.sendMessage(chatId, text);
    return true;
  } catch {
    return false;
  }
}
