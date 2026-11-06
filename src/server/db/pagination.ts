import { AppError } from "../errors";

/** Keyset pagination cursor over (created_at desc, id desc). */
export interface Cursor { createdAt: Date; id: string }

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): Cursor | null {
  if (!cursor) return null;
  try {
    const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    const createdAt = new Date(iso ?? "");
    if (Number.isNaN(createdAt.getTime()) || !id || !/^[0-9a-f-]{36}$/.test(id)) throw new Error("bad cursor");
    return { createdAt, id };
  } catch {
    throw new AppError("VALIDATION_FAILED", { fields: { cursor: "Invalid page cursor" } });
  }
}

export function toPage<T extends { createdAt: Date; id: string }>(rows: T[], limit: number): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(last) : null };
}
