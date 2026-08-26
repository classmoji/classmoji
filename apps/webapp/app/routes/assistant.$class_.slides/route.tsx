// Re-export from the student route, whose loader is role-aware: it allows the
// whole teaching team in assertClassroomAccess and lists every deck — drafts
// included, badged as such — for staff, while students get published decks
// only. That keeps this list in step with the shared view gate, so a draft an
// assistant may open by URL is also one they can find here. The list carries no
// edit affordance for anyone; editing keeps its own creator/allow_team_edit
// gate on the deck editor.
export { loader, default } from '../student.$class.slides/route';
