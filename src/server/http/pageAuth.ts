import "server-only";
import { notFound, redirect } from "next/navigation";
import { currentUser } from "../auth";
import { AppError } from "../errors";
import type { Role, SessionUser } from "../authz/policies";

export const HOME_FOR_ROLE: Record<Role, string> = { homeowner: "/homeowner", builder: "/builder", admin: "/admin" };

/** Route protection for server-rendered pages. Authoritative, unlike the proxy's cookie check. */
export async function requirePageUser(roles: Role[], path: string): Promise<SessionUser> {
  const cu = await currentUser();
  if (cu.state === "expired") redirect(`/sign-in?expired=1&next=${encodeURIComponent(path)}`);
  if (cu.state !== "active") redirect(`/sign-in?next=${encodeURIComponent(path)}`);
  if (!roles.includes(cu.user.role)) redirect(HOME_FOR_ROLE[cu.user.role]);
  return cu.user;
}

/** Turns expected service errors into the right page outcome. */
export async function loadOr404<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError && (err.code === "NOT_FOUND" || err.code === "FORBIDDEN")) notFound();
    throw err;
  }
}
