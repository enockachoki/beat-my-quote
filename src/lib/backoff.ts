/** Exponential backoff with "full jitter" (AWS architecture blog), shared by browser and server. */
export function backoffDelayMs(attempt: number, baseMs = 250, maxMs = 10_000, random: () => number = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(random() * exp);
}
