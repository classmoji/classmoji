import { useLoaderData } from 'react-router';
import { ClassmojiService, getAuthSession } from '~/utils/db.server.js';
import { generateTermString } from '@classmoji/utils';

/**
 * Root index route.
 * Shows a list of classrooms the user has access to,
 * so they can navigate to the right one.
 */
export const loader = async ({ request }) => {
  const authData = await getAuthSession(request).catch(() => null);

  if (!authData) {
    return { classrooms: [] };
  }

  const memberships = await ClassmojiService.classroomMembership.findByUserId(authData.userId);

  // Sort by classroom name
  const sortedMemberships = memberships.sort((a, b) =>
    a.classroom.name.localeCompare(b.classroom.name)
  );

  return {
    classrooms: sortedMemberships.map(m => ({
      slug: m.classroom.slug,
      name: m.classroom.name,
      term: m.classroom.term,
      year: m.classroom.year,
      role: m.role,
    })),
  };
};

const Index = () => {
  const { classrooms } = useLoaderData();

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-[#191919]">
      <div className="max-w-2xl mx-auto px-4 py-16">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
          Pages
        </h1>
        <p className="text-gray-500 dark:text-gray-400 mb-8">
          Select a classroom to view its pages.
        </p>

        {classrooms.length > 0 ? (
          <div className="space-y-2">
            {classrooms.map((c) => (
              <a
                key={c.slug}
                href={`/${c.slug}`}
                className="block p-4 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg hover:shadow-md transition-shadow"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 text-xs bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 rounded uppercase">
                      {generateTermString(c.term, c.year)}
                    </span>
                    <span className="font-medium text-gray-900 dark:text-white">
                      {c.name}
                    </span>
                  </div>
                  <span className="text-xs text-gray-400 uppercase">{c.role}</span>
                </div>
              </a>
            ))}
          </div>
        ) : (
          <div className="text-center py-12 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
            <p className="text-gray-500 dark:text-gray-400">
              No classrooms found. Log in to the main app first.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default Index;
