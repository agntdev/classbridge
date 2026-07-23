/**
 * Short durable ids (WebCrypto — works on Workers and Node).
 * Kept short so callback_data stays under Telegram's 64-byte limit.
 */

export function shortId(prefix = ""): string {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return prefix ? `${prefix}${hex}` : hex;
}
