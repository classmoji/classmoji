import { request, APIRequestContext } from '@playwright/test';
import { getBaseUrl } from './env.helpers';

export type RequestRole = 'owner' | 'assistant' | 'student';

const STORAGE_STATE: Record<RequestRole, string> = {
  owner: './tests/.auth/owner.json',
  assistant: './tests/.auth/assistant.json',
  student: './tests/.auth/student.json',
};

/**
 * Create an API request context authenticated as a specific role's seeded user.
 *
 * Role identities are distinct in the test environment:
 *   owner     = prof-classmoji (OWNER + ASSISTANT + STUDENT)
 *   assistant = fake-ta        (ASSISTANT only)
 *   student   = fake-student-1 (STUDENT only)
 *
 * This lets an owner-context spec issue requests as a non-owner to assert
 * role-denial (403) behaviour. Caller must dispose().
 */
export async function requestAs(role: RequestRole): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: getBaseUrl(),
    storageState: STORAGE_STATE[role],
  });
}
