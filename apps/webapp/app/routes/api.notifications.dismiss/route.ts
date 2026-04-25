import { requireAuth } from '@classmoji/auth/server';
import { notificationService } from '@classmoji/services';
import type { Route } from './+types/route';

const parseIds = (value: FormDataEntryValue | null): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
};

export const action = async ({ request }: Route.ActionArgs) => {
  const { userId } = await requireAuth(request);
  const formData = await request.formData();
  const idsRaw = formData.get('ids');
  const ids = parseIds(idsRaw);
  await notificationService.dismiss(userId, ids);
  return Response.json({ ok: true });
};
