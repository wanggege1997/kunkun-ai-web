import { getSessionTokenFromCookieHeader, verifySessionToken } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export type SessionUser = {
  id: string;
  account: string;
  username: string;
  role: string;
  points: number;
  taskBlocked: boolean;
};

async function getSessionUserByToken(token: string): Promise<SessionUser | null> {
  try {
    const payload = await verifySessionToken(token);
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        account: true,
        username: true,
        role: true,
        points: true,
        taskBlocked: true,
      },
    });
    return user;
  } catch {
    return null;
  }
}

export async function getSessionUserFromCookieHeader(cookieHeader: string | null): Promise<SessionUser | null> {
  const token = getSessionTokenFromCookieHeader(cookieHeader);
  if (!token) return null;
  return getSessionUserByToken(token);
}

export async function getSessionUserFromRequest(request: Request): Promise<SessionUser | null> {
  return getSessionUserFromCookieHeader(request.headers.get('cookie'));
}

export function isAdminUser(user: SessionUser | null): user is SessionUser {
  return !!user && user.role === 'admin';
}
