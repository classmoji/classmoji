import { loadSetStatus, type TeamsRouteArgs } from './teamsData.server.ts';

/**
 * A set's status, as JSON, for the set pages' poll (`useSetStatusPoll`).
 *
 * A RESOURCE route (no component), like `responses/export` and the fill
 * page's `delivery`: the poll reads it with a bare `fetch` once a second while
 * a run or a create moves, and a revalidation instead would re-run the root,
 * layout and page loaders every tick. Light reads only (the service's
 * `pollStatus`: the latest run's number and status, the create's progress and
 * a signature of both), with the lazy expiry every read applies, so a dead run
 * or create ends the poll by itself. The create goes out as counts and states
 * only (`toCreatePollView`): no team name, person or login, so no audit row.
 *
 * The root loader does not run for a resource route, so the gate inside
 * `loadSetStatus` (OWNER or TEACHER, Pro, a set on a CLASSROOM form of this
 * classroom) is the whole wall. Answered `no-store`.
 */
export const loader = (args: TeamsRouteArgs) => loadSetStatus(args);
