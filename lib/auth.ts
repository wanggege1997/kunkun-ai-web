import { SignJWT, jwtVerify } from "jose";
import { NextResponse } from "next/server";

const ACCOUNT_RE = /^\d{10}$/;
const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,10}$/;
const USERNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{1,12}$/;
const SESSION_COOKIE_NAME = "session";

function getSecret() {
  const value =
    process.env.JWT_SECRET ??
    (process.env.NODE_ENV === "production" ? undefined : "dev-only-jwt-secret-change-me");
  if (!value) {
    throw new Error("JWT_SECRET is missing");
  }
  return new TextEncoder().encode(value);
}

export function validateAccount(value: string) {
  return ACCOUNT_RE.test(value);
}

export function validatePassword(value: string) {
  return PASSWORD_RE.test(value);
}

export function validateUsername(value: string) {
  return USERNAME_RE.test(value);
}

export function randomUsername() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let suffix = "";
  for (let i = 0; i < 4; i += 1) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return `用户${suffix}`;
}

export async function signSessionToken(userId: string) {
  return new SignJWT({ userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getSecret());
}

export async function verifySessionToken(token: string) {
  const { payload } = await jwtVerify(token, getSecret());
  return payload as { userId: string };
}

export function setSessionCookie(response: NextResponse, token: string) {
  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(SESSION_COOKIE_NAME, "", {
    path: "/",
    maxAge: 0,
  });
}

export function getSessionTokenFromCookieHeader(cookieHeader: string | null) {
  if (!cookieHeader) return "";
  const chunks = cookieHeader.split(";");
  for (const chunk of chunks) {
    const item = chunk.trim();
    if (!item.startsWith(`${SESSION_COOKIE_NAME}=`)) continue;
    const raw = item.slice(SESSION_COOKIE_NAME.length + 1);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return "";
}
