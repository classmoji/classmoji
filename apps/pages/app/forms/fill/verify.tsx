/**
 * PLACEHOLDER — the magic-link review-and-confirm page.
 *
 * Same reasoning as `fill.tsx`: the route is declared now so the public half of
 * the root auth-gate exemption describes real routes, and so a verification
 * link minted by a later milestone never lands on a 404 in a half-deployed
 * state. It reads no token and touches no database — `verifyMagicToken` and the
 * confirm transaction arrive with the renderer.
 */

export const loader = async ({ params }: { params: Record<string, string | undefined> }) => {
  return { formSlug: params.formSlug ?? '' };
};

export default function FormVerifyPlaceholder() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 px-4 py-16">
      <div className="mx-auto max-w-xl rounded-lg border border-gray-200 bg-white p-8 text-center dark:border-gray-700 dark:bg-gray-800">
        <h1 className="text-lg font-semibold text-gray-900 dark:text-white">Nothing to confirm</h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          Email verification for form responses isn&rsquo;t switched on yet.
        </p>
      </div>
    </div>
  );
}
