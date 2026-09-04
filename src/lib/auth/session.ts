import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";

import type { UserRole } from "@/lib/db/schema";

export const SESSION_COOKIE = "sdc_session";
const SESSION_TTL_SECONDS = 60 * 60 * 8; // 8 hours

export interface SessionUser {
  userId: string;
  email: string;
  fullName: string;
  role: UserRole;
  /** null only for SUPER_ADMIN */
  facilityId: string | null;
  epoch: number;
}

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("AUTH_SECRET is missing or too short (need >= 32 chars).");
  }
  return new TextEncoder().encode(secret);
}

export async function signSession(user: SessionUser): Promise<string> {
  return new SignJWT({ ...user })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretKey());
}

export async function verifySession(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    if (!payload.sub || typeof payload.role !== "string") return null;
    return {
      userId: payload.sub,
      email: String(payload.email ?? ""),
      fullName: String(payload.fullName ?? ""),
      role: payload.role as UserRole,
      facilityId: (payload.facilityId as string | null) ?? null,
      epoch: Number(payload.epoch ?? 1),
    };
  } catch {
    return null;
  }
}

export async function setSessionCookie(user: SessionUser): Promise<void> {
  const token = await signSession(user);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/** Reads the session from the request cookie. Returns null when signed out. */
export async function getSession(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySession(token);
}
