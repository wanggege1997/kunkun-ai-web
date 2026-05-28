import { NextRequest } from 'next/server';
import { POST as runPost } from '@/app/api/run/route';

export async function POST(request: NextRequest) {
  return runPost(request);
}
