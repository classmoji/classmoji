import { ClassmojiService } from '@classmoji/services';
import { requirePlatformAdmin } from '~/utils/db.server';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';

/**
 * Self-managed GitLab instances people connected at /gitlab/setup. Turning one
 * off stops sign-in and new connections through it; classrooms already on it
 * keep working. "Replace credentials" is for when the OAuth application on the
 * instance was deleted or its secret rotated.
 */

export interface InstanceRow {
  id: string;
  host: string;
  clientId: string;
  disabled: boolean;
  createdAt: string;
  createdBy: string | null;
  groups: number;
  connections: number;
}

export async function loadGitLabInstances({ request }: LoaderFunctionArgs) {
  await requirePlatformAdmin(request);
  const rows = await ClassmojiService.gitlabInstance.list();
  return {
    defaultHost: ClassmojiService.gitlabInstance.defaultHost(),
    rows: rows.map(
      (r): InstanceRow => ({
        id: r.id,
        host: r.host,
        clientId: r.client_id,
        disabled: Boolean(r.disabled_at),
        createdAt: r.created_at.toISOString(),
        createdBy: r.created_by?.name ?? r.created_by?.login ?? r.created_by?.email ?? null,
        groups: r._count.git_organizations,
        connections: r._count.connections,
      })
    ),
  };
}

export async function gitLabInstancesAction({ request }: ActionFunctionArgs) {
  await requirePlatformAdmin(request);
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  const instanceId = String(form.get('instanceId') ?? '');
  if (!instanceId) return { error: 'No instance named.' };
  const svc = ClassmojiService.gitlabInstance;

  try {
    if (intent === 'toggle') {
      await svc.setDisabled(instanceId, form.get('disabled') === 'true');
      return { ok: true };
    }
    if (intent === 'credentials') {
      const clientId = String(form.get('clientId') ?? '').trim();
      const clientSecret = String(form.get('clientSecret') ?? '').trim();
      if (!clientId || !clientSecret)
        return { error: 'Both the Application ID and Secret are needed.' };
      await svc.updateCredentials(instanceId, clientId, clientSecret);
      return { ok: true };
    }
  } catch (error: unknown) {
    console.error('[admin] gitlab instance update failed:', error);
    return { error: 'Could not update that instance. Try again.' };
  }
  return { error: 'Unknown action.' };
}
