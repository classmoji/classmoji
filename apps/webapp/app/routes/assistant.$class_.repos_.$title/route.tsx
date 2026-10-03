// The repository page an assistant reaches from View on the repositories list.
//
// Same page as the owner's, read-only: `canEdit` there is false outside /admin,
// which drops Autograde, the repository menu (Edit, Assign graders, Update
// student repositories, Calculate contributions), the assignment Edit and the
// grades-released switch. The submissions roster — the reason an assistant is
// here — stays.
//
// The loader is the admin one behind requireClassroomTeachingTeam. It comes
// from a `.server` module rather than the admin ROUTE module: React Router only
// strips `loader`/`action`/`middleware`/`headers`, so a loader exported from a
// route file would drag its server-only imports into the client bundle. The
// ACTION is deliberately not re-exported — writes stay behind
// requireClassroomAdmin on /admin.
import { teachingTeamLoader } from '../admin.$class.repos_.$title/loader.server';

export { default } from '../admin.$class.repos_.$title/route';

export const loader = teachingTeamLoader;
