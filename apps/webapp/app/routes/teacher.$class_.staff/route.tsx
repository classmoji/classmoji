// Re-export from the admin route, whose LOADER reads at the teaching-team tier
// (requireClassroomTeachingTeam) and builds each row from an explicit field
// allowlist — identity, role and status only, for every viewer including an
// owner. Its `canManage` flag additionally requires the /admin prefix, so the
// list renders read-only here.
//
// The `action` is deliberately NOT re-exported. Adding, updating and removing
// staff are OWNER-only, and a route with no action export has no POST target at
// all — the mutations simply do not exist under the teacher prefix, rather than
// existing and refusing. Do not add one.
export { loader, default } from '../admin.$class.staff/route';
