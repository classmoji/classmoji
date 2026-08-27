// Re-export from the admin route, whose LOADER reads at the teaching-team tier
// (requireClassroomTeachingTeam) and splits the payload server-side: contact
// details and the membership grade fields are serialized for an OWNER only, so
// a teacher's page never receives them. Its `canManage` flag additionally
// requires the /admin prefix, so the roster renders read-only here.
//
// The `action` is deliberately NOT re-exported. Removing a student and revoking
// an invite are OWNER-only, and a route with no action export has no POST target
// at all — the mutations simply do not exist under the teacher prefix, rather
// than existing and refusing. Do not add one.
export { loader, default } from '../admin.$class.students/route';
