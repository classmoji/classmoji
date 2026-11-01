import { ClassmojiService } from '@classmoji/services';
import { requirePlatformAdmin } from '~/utils/db.server';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';

/**
 * Self-managed GitLab instances requested at /gitlab/setup. A new one waits
 * here for approval (never automatic): nobody can sign in through it until a
 * platform admin approves it, because everyone at that school would sign in
 * through the requester's OAuth application. Declining deletes the request.
 * Turning an approved one off stops sign-in and new connections through it;
 * classrooms already on it keep working. "Replace credentials" is for when the
 * OAuth application on the instance was deleted, its secret rotated, or the
 * school's Gitlab admin made an instance-wide one to replace a person's.
 */

export interface InstanceRow {
  id: string;
  host: string;
  clientId: string;
  disabled: boolean;
  pending: boolean;
  createdAt: string;
  requester: {
    name: string | null;
    username: string | null;
    email: string | null;
    emailConfirmed: boolean;
    isAdmin: boolean;
    since: string | null;
    note: string | null;
    /** The email's domain is the host's (or a parent of it), e.g. cs.school.edu under school.edu. */
    emailMatchesHost: boolean;
  };
  createdBy: string | null;
  groups: number;
  connections: number;
}

function emailMatchesHost(email: string | null, host: string): boolean {
  const domain = email?.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  const hostname = new URL(host).hostname.toLowerCase();
  return hostname === domain || hostname.endsWith(`.${domain}`);
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
        pending: !r.approved_at,
        createdAt: r.created_at.toISOString(),
        requester: {
          name: r.requester_name,
          username: r.requester_username,
          email: r.requester_email,
          emailConfirmed: r.requester_email_confirmed,
          isAdmin: r.requester_is_admin,
          since: r.requester_since?.toISOString() ?? null,
          note: r.request_note,
          emailMatchesHost: emailMatchesHost(r.requester_email, r.host),
        },
        createdBy: r.created_by?.name ?? r.created_by?.email ?? null,
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
    if (intent === 'approve') {
      await svc.approve(instanceId);
      return { ok: true };
    }
    if (intent === 'reject') {
      await svc.reject(instanceId);
      return { ok: true };
    }
    if (intent === 'toggle') {
      await svc.setDisabled(instanceId, form.get('disabled') === 'true');
      return { ok: true };
    }
    if (intent === 'check') {
      return { health: await svc.checkHealth(instanceId) };
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
