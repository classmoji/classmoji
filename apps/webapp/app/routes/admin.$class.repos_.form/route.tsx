import { namedAction } from 'remix-utils/named-action';
import { useNavigate, useParams } from 'react-router';
import type { ShouldRevalidateFunctionArgs } from 'react-router';
import { IconChevronLeft, IconFolder } from '@tabler/icons-react';

import { requireClassroomAdmin, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import FormModule from './FormModule';
import { ClassmojiService } from '@classmoji/services';
import getPrisma from '@classmoji/database';
import { ActionTypes } from '~/constants';
import type { Route } from './+types/route';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { class: classSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'REPOSITORIES',
    action: 'view_module_form',
  });

  const url = new URL(request.url);
  const moduleTitle = url.searchParams.get('title');
  const tags = await ClassmojiService.organizationTag.findByClassroomId(classroom.id);

  let repository = null;
  let hasReposWithProjects = false;
  let hasProvisionedRepos = false;

  if (moduleTitle) {
    repository = await ClassmojiService.repository.findBySlugAndTitle(classSlug!, moduleTitle, {
      includePages: true,
      includeSlides: true,
    });

    // Check if any repos have projects (for locking project template field)
    if (repository) {
      const reposWithProjects = await getPrisma().gitRepo.count({
        where: {
          repository_id: repository.id,
          project_id: { not: null },
        },
      });
      hasReposWithProjects = reposWithProjects > 0;

      // Type and team formation decide whether each copy belongs to a student
      // or a team, which is baked into the repos already on GitHub. Flipping
      // either once they exist would strand every one of them.
      hasProvisionedRepos =
        (await getPrisma().gitRepo.count({ where: { repository_id: repository.id } })) > 0;

      const autogradingTests = await ClassmojiService.autogradingTest.findByRepositoryId(
        repository.id
      );
      repository = { ...repository, autograding_tests: autogradingTests };
    }
  }

  // Get all pages and slides for this classroom (for linking options)
  const pages = await ClassmojiService.page.findByClassroomId(classroom.id, {
    includeLinks: true,
  });
  const slides = await getPrisma().slide.findMany({
    where: { classroom_id: classroom.id },
    include: {
      links: {
        include: { repository: true },
      },
    },
    orderBy: { title: 'asc' },
  });

  return {
    repository,
    isNew: !repository,
    tags,
    classroom,
    pages,
    slides,
    hasReposWithProjects,
    hasProvisionedRepos,
  };
};

// Inline tag creation mints one tag the form already renders locally (FormModule
// merges the action's tag into the Select's options), so re-running this loader
// buys nothing — and it costs: a fresh `repository` object would disturb edits the
// instructor hasn't saved yet, and the whole heavy load (GitHub-backed repository,
// pages, slides) would run behind the Create button. Skip it for that one named
// action; everything else keeps the default behaviour.
export const shouldRevalidate = ({
  formAction,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) => {
  if (formAction && new URL(formAction, 'http://localhost').searchParams.has('/createTag')) {
    return false;
  }

  return defaultShouldRevalidate;
};

const ModuleForm = ({ loaderData }: Route.ComponentProps) => {
  const {
    repository,
    isNew,
    tags,
    classroom,
    pages,
    slides,
    hasReposWithProjects,
    hasProvisionedRepos,
  } = loaderData;
  const navigate = useNavigate();
  const { class: classSlug } = useParams();
  // Repositories are managed on the Repositories page; assignments that
  // submit through them live on the module page.
  const goBack = () => navigate(`/admin/${classSlug}/repos`);
  // FormModule calls `close` on Discard and after a successful save.
  const close = () => navigate(-1);

  return (
    <div className="min-h-full relative">
      {/* Breadcrumb header */}
      <div className="flex items-center gap-2 text-ink-2 mt-2 mb-4">
        <button
          type="button"
          onClick={goBack}
          className="hover:text-ink-1"
          aria-label="Back to repositories"
        >
          <IconChevronLeft size={18} />
        </button>
        <IconFolder size={18} className="text-gray-400" />
        <button type="button" onClick={goBack} className="hover:text-ink-1">
          Repositories
        </button>
        <span className="text-ink-3">/</span>
        <span className="font-semibold text-ink-1">
          {isNew ? 'New repository' : (repository?.title ?? 'Edit repository')}
        </span>
      </div>

      <FormModule
        repository={repository as Parameters<typeof FormModule>[0]['repository']}
        isNew={isNew}
        close={close}
        tags={tags}
        classroom={classroom as Parameters<typeof FormModule>[0]['classroom']}
        pages={pages}
        slides={slides}
        hasReposWithProjects={hasReposWithProjects}
        hasProvisionedRepos={hasProvisionedRepos}
      />
    </div>
  );
};

export const action = async ({ request, params }: Route.ActionArgs) => {
  const { class: classSlug } = params;

  const {
    classroom,
    userId: _userId,
    membership,
  } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'REPOSITORIES',
    action: 'create_repository',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const data = await request.json();

  // Extract fields that shouldn't go to Prisma. moduleData is never written
  // as-is: the service keeps only the columns the form edits
  // (repository.REPOSITORY_FORM_FIELDS).
  const {
    organization: _organization,
    tag,
    linkedPageIds,
    linkedSlideIds,
    autogradingTests,
    ...moduleData
  } = data;

  const saveError = (error: string) => ({ error, action: ActionTypes.SAVE_ASSIGNMENT });

  /** Non-empty string ids from a body value that should be a list of ids. */
  const idList = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];

  /** A tag id is usable only if it is one of this classroom's tags (or absent). */
  const isClassroomTag = async (tagId: unknown) => {
    if (!tagId) return true;
    if (typeof tagId !== 'string') return false;
    const tags = await ClassmojiService.organizationTag.findByClassroomId(classroom.id);
    return tags.some(t => t.id === tagId);
  };

  /** Repository titles are unique per classroom ([classroom_id, title]). */
  const isTitleTaken = (error: unknown) => (error as { code?: unknown } | null)?.code === 'P2002';
  const TITLE_TAKEN = 'A repository with this title already exists.';

  // Linked pages and slides are limited to this classroom's own; other ids are
  // ignored rather than linked.
  const classroomPageIds = async (ids: string[]) => {
    if (ids.length === 0) return [];
    const rows = await getPrisma().page.findMany({
      where: { id: { in: ids }, classroom_id: classroom.id },
      select: { id: true },
    });
    const owned = new Set(rows.map(r => r.id));
    return ids.filter(id => owned.has(id));
  };
  const classroomSlideIds = async (ids: string[]) => {
    if (ids.length === 0) return [];
    const rows = await getPrisma().slide.findMany({
      where: { id: { in: ids }, classroom_id: classroom.id },
      select: { id: true },
    });
    const owned = new Set(rows.map(r => r.id));
    return ids.filter(id => owned.has(id));
  };

  // Helper to sync repository-level content links. Only called with a
  // repository already known to belong to this classroom.
  const syncModuleContentLinks = async (moduleId: string) => {
    // Get current links for this repository
    const currentPageLinks = await getPrisma().pageLink.findMany({
      where: { repository_id: moduleId },
      select: { page_id: true },
    });
    const currentSlideLinks = await getPrisma().slideLink.findMany({
      where: { repository_id: moduleId },
      select: { slide_id: true },
    });

    const currentPageIds = currentPageLinks.map(l => l.page_id);
    const currentSlideIds = currentSlideLinks.map(l => l.slide_id);

    const newPageIds = await classroomPageIds(idList(linkedPageIds));
    const newSlideIds = await classroomSlideIds(idList(linkedSlideIds));

    // Pages to add and remove
    const pagesToAdd = newPageIds.filter((id: string) => !currentPageIds.includes(id));
    const pagesToRemove = currentPageIds.filter(id => !newPageIds.includes(id));

    // Slides to add and remove
    const slidesToAdd = newSlideIds.filter((id: string) => !currentSlideIds.includes(id));
    const slidesToRemove = currentSlideIds.filter(id => !newSlideIds.includes(id));

    // Add new page links
    if (pagesToAdd.length > 0) {
      await getPrisma().pageLink.createMany({
        data: pagesToAdd.map((pageId: string) => ({
          page_id: pageId,
          repository_id: moduleId,
        })),
        skipDuplicates: true,
      });
    }

    // Remove old page links
    if (pagesToRemove.length > 0) {
      await getPrisma().pageLink.deleteMany({
        where: {
          repository_id: moduleId,
          page_id: { in: pagesToRemove },
        },
      });
    }

    // Add new slide links
    if (slidesToAdd.length > 0) {
      await getPrisma().slideLink.createMany({
        data: slidesToAdd.map((slideId: string) => ({
          slide_id: slideId,
          repository_id: moduleId,
        })),
        skipDuplicates: true,
      });
    }

    // Remove old slide links
    if (slidesToRemove.length > 0) {
      await getPrisma().slideLink.deleteMany({
        where: {
          repository_id: moduleId,
          slide_id: { in: slidesToRemove },
        },
      });
    }
  };

  // Helper to save content manifest to GitHub repo
  const saveContentManifest = async () => {
    await ClassmojiService.contentManifest.saveManifest(classroom.id);
  };

  return namedAction(request, {
    // Lets an instructor add a team tag from the group-assignment form without
    // leaving for Settings → Team. Upsert, so re-typing an existing name hands
    // back that tag instead of tripping the [classroom_id, name] unique index.
    async createTag() {
      const name = typeof data.name === 'string' ? data.name.trim() : '';
      if (!name) return { error: 'Please enter a tag name.' };

      try {
        const createdTag = await ClassmojiService.organizationTag.upsert(classroom.id, name);
        return { tag: { id: createdTag.id, name: createdTag.name } };
      } catch (error: unknown) {
        console.error('Tag create error:', error);
        return { error: 'Failed to create tag. Please try again.' };
      }
    },
    async create() {
      if (!(await isClassroomTag(tag))) {
        return saveError('Please choose a team tag from this classroom.');
      }

      try {
        // Form-owned columns only; the classroom always comes from the route.
        const createdModule = await ClassmojiService.repository.create(
          ClassmojiService.repository.createFromFormData(moduleData, classroom.id, tag || null)
        );

        // Sync repository-level content links
        await syncModuleContentLinks(createdModule.id);
        await ClassmojiService.autogradingTest.replaceForRepository(
          createdModule.id,
          autogradingTests || []
        );

        // Save content manifest to GitHub repo
        await saveContentManifest();

        return {
          success: 'Repository created',
          action: ActionTypes.SAVE_ASSIGNMENT,
        };
      } catch (error: unknown) {
        if (isTitleTaken(error)) return saveError(TITLE_TAKEN);
        console.error('Repository create error:', error);
        return {
          error: 'Failed to create repository. Please try again.',
          action: ActionTypes.SAVE_ASSIGNMENT,
        };
      }
    },
    async update() {
      // The repository must belong to this classroom before anything is
      // written: the form fields, its content links and its autograding tests.
      const repositoryId = typeof moduleData.id === 'string' ? moduleData.id : '';
      const repository = repositoryId
        ? await getPrisma().repository.findFirst({
            where: { id: repositoryId, classroom_id: classroom.id },
            select: { id: true },
          })
        : null;
      if (!repository) return saveError('Repository not found.');

      // The tag only matters for a GROUP repository: the service ignores it
      // otherwise, and the form always sends the stored tag_id, so a leftover
      // tag on an INDIVIDUAL repository must not block the save.
      if (moduleData.type === 'GROUP' && !(await isClassroomTag(tag))) {
        return saveError('Please choose a team tag from this classroom.');
      }

      try {
        await ClassmojiService.repository.updateFromForm(
          { ...moduleData, id: repository.id, tag },
          classroom.id
        );

        // Sync repository-level content links
        await syncModuleContentLinks(repository.id);
        await ClassmojiService.autogradingTest.replaceForRepository(
          repository.id,
          autogradingTests || []
        );

        // Save content manifest to GitHub repo
        await saveContentManifest();

        return {
          success: 'Repository updated',
          action: ActionTypes.SAVE_ASSIGNMENT,
        };
      } catch (error: unknown) {
        if (isTitleTaken(error)) return saveError(TITLE_TAKEN);
        console.error('Repository update error:', error);
        return {
          error: 'Failed to update repository. Please try again.',
          action: ActionTypes.SAVE_ASSIGNMENT,
        };
      }
    },
  });
};

export default ModuleForm;
