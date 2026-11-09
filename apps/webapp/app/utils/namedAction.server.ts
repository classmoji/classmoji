/**
 * Vendored from remix-utils 7.7.0 (`remix-utils/named-action`) by Sergio
 * Xalambrí, MIT License. Copyright (c) 2021 Sergio Xalambrí.
 *
 * Same lookup order as the original: for a Request, a `/name` key in the
 * URL's search params (React Router's `?/name` action URL), then `intent`,
 * `action`, `_action` in the URL; then the same four in a clone of the
 * body's FormData. Later remix-utils majors read only `intent` from
 * FormData, which is why this copy is kept instead of upgrading.
 */

// The original declarations typed responses with `TypedResponse` from
// `@remix-run/server-runtime`, which is not installed here, so it resolved
// to `any`. These types keep that surface so callers infer exactly as before.
type ActionsRecord = Record<string, () => Promise<unknown>>;

/**
 * Runs an action based on the request's action name
 * @param request The request to parse for an action name
 * @param actions The map of actions to run
 * @returns The response from the action
 * @throws {ReferenceError} Action name not found
 * @throws {ReferenceError} Action "${name}" not found
 */
export function namedAction<Actions extends ActionsRecord>(
  request: Request,
  actions: Actions
): Promise<any>;
export function namedAction<Actions extends ActionsRecord>(
  url: URL,
  actions: Actions
): Promise<any>;
export function namedAction<Actions extends ActionsRecord>(
  searchParams: URLSearchParams,
  actions: Actions
): Promise<any>;
export function namedAction<Actions extends ActionsRecord>(
  formData: FormData,
  actions: Actions
): Promise<any>;
export async function namedAction(
  input: Request | URL | URLSearchParams | FormData,
  actions: ActionsRecord
): Promise<any> {
  let name = await getActionName(input);
  if (name && name in actions) {
    return actions[name]();
  }
  if (name === null && 'default' in actions) {
    return actions.default();
  }
  if (name === null) throw new ReferenceError('Action name not found');
  throw new ReferenceError(`Action "${name}" not found`);
}

async function getActionName(
  input: Request | URL | URLSearchParams | FormData
): Promise<string | null> {
  if (input instanceof Request) {
    let actionName = findNameInURL(new URL(input.url).searchParams);
    if (actionName) return actionName;
    return findNameInFormData(await input.clone().formData());
  }
  if (input instanceof URL) {
    return findNameInURL(input.searchParams);
  }
  if (input instanceof URLSearchParams) {
    return findNameInURL(input);
  }
  if (input instanceof FormData) {
    return findNameInFormData(input);
  }
  return null;
}

function findNameInURL(searchParams: URLSearchParams): string | null {
  for (let key of searchParams.keys()) {
    if (key.startsWith('/')) return key.slice(1);
  }
  let actionName = searchParams.get('intent');
  if (typeof actionName === 'string') return actionName;
  actionName = searchParams.get('action');
  if (typeof actionName === 'string') return actionName;
  actionName = searchParams.get('_action');
  if (typeof actionName === 'string') return actionName;
  return null;
}

function findNameInFormData(formData: FormData): string | null {
  for (let key of formData.keys()) {
    if (key.startsWith('/')) return key.slice(1);
  }
  let actionName = formData.get('intent');
  if (typeof actionName === 'string') return actionName;
  actionName = formData.get('action');
  if (typeof actionName === 'string') return actionName;
  actionName = formData.get('_action');
  if (typeof actionName === 'string') return actionName;
  return null;
}
