import { z } from "zod";

/** Normalize common email-entry punctuation; passwords must never pass through this. */
export function normalizeAuthEmail(value: string): string {
  return value.trim().replace(/＠/g, "@").replace(/[．。｡]/g, ".");
}

export const authEmail = z.string().transform(normalizeAuthEmail).pipe(z.string().email());

/** Optional deployment alias for an existing account; no extra user is created. */
export function configuredLoginUsername(): { username: string; userId: number } | undefined {
  const username = process.env.LOGIN_USERNAME || "";
  const rawId = process.env.LOGIN_USER_ID || "";
  if (!username && !rawId) return undefined;
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(username) || !/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(Number(rawId))) {
    throw new Error("LOGIN_USERNAME and LOGIN_USER_ID must configure a valid username and positive safe user ID together");
  }
  return { username, userId: Number(rawId) };
}

export function authLoginIdentity(usernameEnabled: boolean) {
  return usernameEnabled
    ? z.union([authEmail, z.string().trim().regex(/^[A-Za-z0-9_.-]{1,64}$/)])
    : authEmail;
}
