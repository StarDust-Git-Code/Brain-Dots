import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
import { ApiError, handle, requireUser } from '../../../lib/auth';
import { rateLimit } from '../../../lib/rate-limit';
import { store } from '../../../lib/store';

export async function GET(req: Request) {
  return handle(async () => {
    const { uid } = await requireUser(req);
    if (!rateLimit(`${uid}:/api/state`)) {
      throw new ApiError(429, 'Too many requests. Try again shortly.');
    }
    const [memories, tasks, setup] = await Promise.all([
      store.memories.list(uid),
      store.tasks.list(uid),
      store.setup.status(),
    ]);
    return NextResponse.json({
      settings: { name: 'Dot' },
      memories,
      tasks,
      setup,
      configured: setup.model,
    });
  });
}
