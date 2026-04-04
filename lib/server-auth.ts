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

export async function getSessionUserFromRequest(request: Request): Promise<SessionUser | null> {
  const token = getSessionTokenFromCookieHeader(request.headers.get('cookie'));
  if (!token) return null;

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

export function isAdminUser(user: SessionUser | null): user is SessionUser {
  return !!user && user.role === 'admin';
}
