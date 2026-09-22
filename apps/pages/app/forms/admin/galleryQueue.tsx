import { data, useFetcher, useLoaderData } from 'react-router';
import { requireClassroomTeachingTeam } from '@classmoji/auth/server';
import GalleryCell from '~/components/forms/GalleryCell.tsx';
import { ClassmojiService, prisma } from '~/utils/db.server.ts';
import { FORMS_RESOURCE, NO_STORE } from './responsesData.server.ts';

/**
 * `/{class}/forms/{slug}/gallery`: the teaching team's gallery queue. It exists
 * because the responses page is OWNER/TEACHER + Pro (`assertFormAdmin`) and the
 * spec lets assistants approve. It shows each submitted response's project
 * title and gallery status and nothing else: no name, email or other answer
 * reaches the browser. Approve/Hide post to the moderation endpoint; the
 * fetcher's revalidation reloads this list.
 */
export const loader = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  const { classroom } = await requireClassroomTeachingTeam(request, params.classroomSlug!, {
    resourceType: FORMS_RESOURCE,
    action: 'view_gallery_queue',
  });
  const form = await ClassmojiService.form.findBySlug(classroom.id, params.formSlug!);
  if (!form || !form.gallery_org_id) throw new Response('Form not found', { status: 404 });

  const [rows, revisions] = await Promise.all([
    ClassmojiService.formResponse.listByFormId(form.id, { submissionState: 'SUBMITTED' }),
    prisma.formRevision.findMany({
      where: { form_id: form.id },
      select: { id: true, fields: true },
    }),
  ]);
  // Each response is read through the roles of the revision it was filled under.
  const fieldsByRevision = new Map(
    revisions.map(revision => [revision.id, ClassmojiService.form.fieldsOf(revision.fields)])
  );
  const items = rows.map(row => ({
    id: row.id,
    title: ClassmojiService.gallery.projectFromResponse(
      row,
      fieldsByRevision.get(row.revision_id) ?? [],
      { name: '', slug: '' }
    ).title,
    galleryStatus: row.gallery_status,
  }));

  return data(
    {
      classroomSlug: params.classroomSlug!,
      formSlug: form.slug,
      formTitle: form.title,
      items,
    },
    { headers: NO_STORE }
  );
};

export const headers = ({ loaderHeaders }: { loaderHeaders: Headers }) => loaderHeaders;

export default function GalleryQueue() {
  const { classroomSlug, formSlug, formTitle, items } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const setGallery = (id: string, status: 'APPROVED' | 'HIDDEN') =>
    fetcher.submit({ responseIds: [id], status } as never, {
      method: 'post',
      action: `/${classroomSlug}/forms/${formSlug}/responses/gallery`,
      encType: 'application/json',
    });

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="mt-2 mb-4 text-base font-semibold text-gray-600 dark:text-gray-400">
        {formTitle}
        <span className="mx-1.5 text-gray-300 dark:text-gray-600">/</span>
        Gallery
      </h1>
      <div className="rounded-2xl bg-white p-5 ring-1 ring-stone-200 sm:p-6 dark:bg-neutral-900 dark:ring-neutral-800">
        {items.length === 0 ? (
          <div className="py-12 text-center text-gray-500 dark:text-gray-400">
            <div className="font-medium">No submissions yet</div>
            <div className="text-sm">Submitted projects appear here for approval.</div>
          </div>
        ) : (
          <ul className="divide-y divide-stone-200 dark:divide-neutral-800">
            {items.map(item => (
              <li key={item.id} className="flex items-center justify-between gap-4 py-3">
                <span className="text-sm text-gray-900 dark:text-gray-100">{item.title}</span>
                <GalleryCell
                  status={item.galleryStatus}
                  onChange={status => setGallery(item.id, status)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
