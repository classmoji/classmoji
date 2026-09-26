// Reading the "Update repositories" request, shared by admin.$class.repos.update
// and admin.$class.repos_.$title.update.

export interface UpdateRequest {
  repositoryId: string;
  values: { title: string; description?: string | null; branchName?: string | null };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isOptionalString = (value: unknown) =>
  value === undefined || value === null || typeof value === 'string';

/**
 * Parse the modal's `{ values, repository: { id } }` body. Returns null for a
 * body that is not JSON or not that shape: `values` must be an object with a
 * string `title`, and `description` / `branchName` strings when present.
 */
export const parseUpdateRequest = async (request: Request): Promise<UpdateRequest | null> => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (!isRecord(body) || !isRecord(body.values)) return null;

  const { values } = body;
  if (typeof values.title !== 'string') return null;
  if (!isOptionalString(values.description) || !isOptionalString(values.branchName)) return null;

  const repositoryId = isRecord(body.repository) ? body.repository.id : undefined;
  if (typeof repositoryId !== 'string' || !repositoryId) return null;

  return {
    repositoryId,
    values: {
      title: values.title,
      description: values.description as string | null | undefined,
      branchName: values.branchName as string | null | undefined,
    },
  };
};
