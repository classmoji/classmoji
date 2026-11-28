import { requestImpersonator } from '@classmoji/auth/request-impersonator';
import type { AuditActor } from '@classmoji/services/audit';
import type { Role } from '@classmoji/database/client';

/** The part of a classroom gate's result an actor is built from. */
interface GateResult {
  userId: string;
  membership: { role: Role } | null | undefined;
}

/**
 * Who a shared service records a change for when the service writes the audit
 * row itself (grading: grades, graders, late overrides, grade release,
 * submission delete): the gate's user and role, `tool` naming the route and
 * intent (`web:grades.add`), and the platform admin viewing as the user, if
 * any, from the request's server-side session (`requestImpersonator`, as
 * `addClassroomAuditLog` reads it). The route then writes no row of its own.
 */
export async function auditActor(
  request: Request,
  gate: GateResult,
  tool: string
): Promise<AuditActor> {
  const role = gate.membership?.role;
  if (!role) throw new Error(`auditActor(${tool}): the gate resolved no classroom role`);
  return {
    userId: gate.userId,
    role,
    tool,
    impersonatedBy: await requestImpersonator(request),
  };
}
