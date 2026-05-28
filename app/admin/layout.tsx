import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSessionUserFromCookieHeader, isAdminUser } from '@/lib/server-auth';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const headerStore = await headers();
  const sessionUser = await getSessionUserFromCookieHeader(headerStore.get('cookie'));

  if (!isAdminUser(sessionUser)) {
    redirect('/');
  }

  return <>{children}</>;
}
