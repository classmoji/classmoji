import { useLoaderData } from 'react-router';

/**
 * PLACEHOLDER — the public fill page.
 *
 * The real renderer (definition → RHF + zod form, localStorage draft autosave,
 * submit → PENDING_VERIFICATION → magic link) is the next milestone. This route
 * exists NOW so the routing skeleton and the root auth-gate exemption ship
 * together: an exemption written against routes that do not exist yet is an
 * exemption nobody can test, and `tests/e2e/forms-auth-gate.spec.ts` asserts an
 * anonymous GET of this path lands on a page rather than the login screen.
 *
 * It touches NO database and reveals nothing: the same 200 for a real form, a
 * draft one, and a slug that was never created. Deciding what an anonymous
 * visitor may learn about a form is the renderer's job, and guessing at it here
 * would be a disclosure decision made in throwaway code.
 */

export const loader = async ({ params }: { params: Record<string, string | undefined> }) => {
  return {
    classroomSlug: params.classroomSlug ?? '',
    formSlug: params.formSlug ?? '',
  };
};

export default function FormFillPlaceholder() {
  const { formSlug } = useLoaderData<typeof loader>();

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 px-4 py-16">
      <div className="mx-auto max-w-xl rounded-lg border border-gray-200 bg-white p-8 text-center dark:border-gray-700 dark:bg-gray-800">
        <h1 className="text-lg font-semibold text-gray-900 dark:text-white">
          This form isn&rsquo;t open yet
        </h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          <span className="font-mono">{formSlug}</span> will be fillable here shortly.
        </p>
      </div>
    </div>
  );
}
