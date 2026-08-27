import { redirect, useNavigate, useFetcher, useSearchParams, useRevalidator } from 'react-router';
import { useState, useEffect, useRef } from 'react';
import { useForm, FormProvider } from 'react-hook-form';
import { Button, Card, Alert, Steps, Spin } from 'antd';

import { getAuthSession, clearRevokedToken } from '@classmoji/auth/server';
import { useGlobalFetcher, useGitHubAppInstallPopup } from '~/hooks';
import { ClassmojiService, GitHubProvider } from '@classmoji/services';
import { ActionTypes } from '~/constants';
import getPrisma from '@classmoji/database';
import { defaultContentRepoName, suggestContentNamespace } from '@classmoji/utils';

import StepBasicInfo from './StepBasicInfo';
import StepImportModules from './StepImportModules';
import StepReview from './StepReview';
import { slugify, STEPS } from './utils';
import { SOURCE_ROLES } from './sourceAccess';
import type { ImportSelections } from './types';
import type { Route } from './+types/route';

export const loader = async ({ request }: Route.LoaderArgs) => {
  const authData = await getAuthSession(request);

  if (!authData?.token) return redirect('/');

  const octokit = GitHubProvider.getUserOctokit(authData.token);

  // Run the two independent GitHub reads in parallel:
  //  - getAuthenticated: needed for the Classmoji user lookup + revoked-token handling
  //  - syncUserInstallations: reads the user's app installations live from GitHub and
  //    upserts a GitOrganization row for each. This decouples the org dropdown from the
  //    async installation.created webhook, so a just-installed org shows up immediately.
  //    On failure it resolves to null and we fall back to the GraphQL path below.
  const [authResult, initialSync] = await Promise.all([
    octokit.rest.users
      .getAuthenticated()
      .then(res => ({ ok: true as const, data: res.data }))
      .catch((error: unknown) => ({ ok: false as const, error })),
    ClassmojiService.gitOrganization.syncUserInstallations(octokit).catch((error: unknown) => {
      console.error(
        'Error syncing user installations:',
        error instanceof Error ? error.message : error
      );
      return null;
    }),
  ]);

  if (!authResult.ok) {
    const error = authResult.error;
    // If bad credentials, clear revoked token from cache AND database
    if (
      (error as { status?: number })?.status === 401 ||
      (error as { message?: string })?.message?.includes('Bad credentials')
    ) {
      await clearRevokedToken(authData.userId);
      return redirect('/');
    }
    throw error;
  }
  const authenticatedUser = authResult.data;
  let syncedInstallations = initialSync;

  const user = await ClassmojiService.user.findByLogin(authenticatedUser.login);

  if (!user) {
    return redirect('/registration');
  }

  // Just installed? GitHub redirects here with ?installation_id=… . The
  // /user/installations list is eventually consistent and may not include the
  // brand-new install yet, so resolve it directly by id (immediately consistent)
  // and merge it in — guaranteeing the org shows on first render, no empty flash.
  const installationIdParam = new URL(request.url).searchParams.get('installation_id');
  if (
    installationIdParam &&
    !(syncedInstallations ?? []).some(i => i.github_installation_id === installationIdParam)
  ) {
    try {
      const justInstalled = await ClassmojiService.gitOrganization.syncInstallationById(
        GitHubProvider.getAppOctokit(),
        installationIdParam
      );
      if (justInstalled) {
        syncedInstallations = [...(syncedInstallations ?? []), justInstalled];
      }
    } catch (error: unknown) {
      console.error(
        'Error resolving just-installed installation:',
        error instanceof Error ? error.message : error
      );
    }
  }

  // Determine which GitOrganization rows to show and their avatars.
  // Primary path: the live installation sync above already upserted the rows.
  // Fallback path: if the installations call failed, use the GraphQL admin-org
  // query and the legacy `github_installation_id: { not: null }` filter.
  let providerIds: string[];
  let avatarByProviderId: Map<string, string | null>;
  let useInstalledFilter = false; // fallback keeps the not:null filter

  if (syncedInstallations) {
    providerIds = syncedInstallations.map(i => i.provider_id);
    avatarByProviderId = new Map(syncedInstallations.map(i => [i.provider_id, i.avatar_url]));
  } else {
    interface GitHubOrgNode {
      id: string;
      databaseId: number;
      login: string;
      name: string;
      avatarUrl: string;
      description: string | null;
      url: string;
      viewerCanAdminister: boolean;
    }
    let nodes: GitHubOrgNode[] = [];
    try {
      const { viewer } = await octokit.graphql<{
        viewer: { organizations: { nodes: GitHubOrgNode[] } };
      }>(`
        {
          viewer {
            organizations(first: 100) {
              nodes {
                id
                databaseId
                login
                name
                avatarUrl
                description
                url
                viewerCanAdminister
              }
            }
          }
        }
      `);
      nodes = viewer.organizations.nodes.filter(org => org.viewerCanAdminister);
    } catch (error: unknown) {
      console.error('Error fetching user orgs:', error instanceof Error ? error.message : error);
    }
    providerIds = nodes.map(org => String(org.databaseId));
    avatarByProviderId = new Map(nodes.map(org => [String(org.databaseId), org.avatarUrl]));
    useInstalledFilter = true;
  }

  // Fetch the displayable orgs and the classrooms this user may import FROM in
  // parallel. Import sources are OWNER *or* TEACHER — a teacher may copy a class
  // they teach, minus the API keys (see the strip in action.ts).
  const [gitOrgs, importableClassrooms] = await Promise.all([
    getPrisma().gitOrganization.findMany({
      where: {
        provider: 'GITHUB',
        provider_id: { in: providerIds },
        ...(useInstalledFilter ? { github_installation_id: { not: null } } : {}),
      },
      include: {
        classrooms: {
          select: {
            id: true,
            slug: true,
            name: true,
          },
        },
      },
    }),
    getPrisma().classroom.findMany({
      where: {
        memberships: {
          some: {
            user_id: user.id,
            // Shared with the action's re-verification. If these two ever drift,
            // the picker offers a source the action refuses — a dead end reached
            // only after the whole wizard has been filled in.
            role: { in: [...SOURCE_ROLES] },
          },
        },
      },
      select: {
        id: true,
        slug: true,
        name: true,
        // THIS viewer's roles only, and only the role column — enough to derive
        // `is_owner` below. A wider select would serialize every member's
        // membership rows into the picker payload.
        memberships: {
          where: { user_id: user.id },
          select: { role: true },
        },
        git_organization: {
          select: {
            login: true,
          },
        },
        // Counts drive the "Also copy" checkboxes on the import step.
        _count: {
          select: {
            pages: true,
            slides: true,
            modules: true,
            calendar_events: true,
            emoji_mappings: true,
            letter_grade_mappings: true,
          },
        },
        repositories: {
          select: {
            id: true,
            title: true,
            template: true,
            type: true,
            weight: true,
            is_extra_credit: true,
            _count: {
              select: {
                assignments: true,
                quizzes: true,
              },
            },
          },
          orderBy: { title: 'asc' },
        },
      },
      orderBy: { created_at: 'desc' },
    }),
  ]);

  // Enrich gitOrgs with avatar URLs from GitHub
  const gitOrgsWithAvatars = gitOrgs.map(org => ({
    ...org,
    avatar_url: avatarByProviderId.get(org.provider_id) ?? null,
  }));

  // Collapse the viewer's membership rows to a single flag and DROP the rows —
  // the picker needs "may this person copy the API keys too", nothing more.
  // `some(OWNER)` rather than reading one row's role: roles are additive and a
  // person may hold both OWNER and TEACHER here, in which case they are an owner.
  const importSources = importableClassrooms.map(({ memberships, ...classroom }) => ({
    ...classroom,
    is_owner: memberships.some(m => m.role === 'OWNER'),
  }));

  return {
    user,
    gitOrgs: gitOrgsWithAvatars,
    importableClassrooms: importSources,
    githubAppName: process.env.GITHUB_APP_NAME,
  };
};

const CreateClassroom = ({ loaderData }: Route.ComponentProps) => {
  const { gitOrgs, importableClassrooms, githubAppName } = loaderData;
  const navigate = useNavigate();
  const { fetcher, notify } = useGlobalFetcher();
  const { openInstallPopup, isRefreshing } = useGitHubAppInstallPopup(githubAppName);

  // Post-install wait. After an install the org isn't in the DB / GitHub's
  // /user/installations list immediately (provisioning + ~1s list lag), so the
  // loader can return zero orgs. Rather than show a dead "no organizations"
  // state, poll the loader until the org appears.
  //
  // "Just installed" is signalled two ways, covering both entry paths:
  //  - direct redirect: login.callback tags the URL with ?installed=1 (and
  //    GitHub's installation_id / setup_action when present)
  //  - in-app popup: the install hook flips isRefreshing on popup close
  const [searchParams] = useSearchParams();
  const revalidator = useRevalidator();
  const cameFromInstall =
    searchParams.has('installed') ||
    searchParams.has('installation_id') ||
    searchParams.get('setup_action') === 'install';
  const pollCountRef = useRef(0);
  const MAX_INSTALL_POLLS = 8; // ~12s at 1.5s intervals

  // Latch "waiting for org" once an install signal is seen, so a single popup
  // revalidation that loses the race against provisioning keeps polling instead
  // of falling back to the empty state.
  const [waitingForInstall, setWaitingForInstall] = useState(cameFromInstall);
  useEffect(() => {
    if (cameFromInstall || isRefreshing) setWaitingForInstall(true);
  }, [cameFromInstall, isRefreshing]);
  useEffect(() => {
    if (gitOrgs.length > 0) setWaitingForInstall(false); // org arrived — done
  }, [gitOrgs.length]);

  useEffect(() => {
    if (!waitingForInstall) return;
    if (gitOrgs.length > 0) return;
    if (revalidator.state !== 'idle') return; // already revalidating
    if (pollCountRef.current >= MAX_INSTALL_POLLS) {
      setWaitingForInstall(false); // give up gracefully → show install prompt
      return;
    }
    const handle = setTimeout(() => {
      pollCountRef.current += 1;
      revalidator.revalidate();
    }, 1500);
    return () => clearTimeout(handle);
  }, [waitingForInstall, gitOrgs.length, revalidator.state]);

  // Show the loading state (not the "no orgs" alert) while waiting for a
  // freshly-installed org to provision.
  const isWaitingForOrg = gitOrgs.length === 0 && waitingForInstall;

  // React Hook Form - persists values across step changes
  const methods = useForm({
    defaultValues: {
      git_org_id: '',
      name: '',
      slug: '',
      content_repo: '',
    },
  });

  const { watch, trigger, getValues } = methods;
  const formValues = watch();

  // Stepper state
  const [currentStep, setCurrentStep] = useState(0);

  // Import state
  const [importEnabled, setImportEnabled] = useState(false);
  const [sourceClassroomId, setSourceClassroomId] = useState<string | null>(null);
  const [selectedModules, setSelectedModules] = useState(
    new Map<string, { includeQuizzes: boolean }>()
  );
  // Settings/content copy groups. Config + drafts-only content default ON
  // (the point of importing is reuse); the two exceptions are secrets
  // (API keys) and calendar events (dates copy as-is), which are opt-in.
  const [importSelections, setImportSelections] = useState<ImportSelections>({
    grading: true,
    gradeScales: true,
    tokens: true,
    features: true,
    aiConfig: true,
    apiKeys: false,
    calendar: false,
    pages: true,
    slides: true,
    modules: true,
    duplicateTemplates: true,
  });

  // Navigate to new classroom on success
  useEffect(() => {
    const fetcherData = fetcher!.data as { classroomSlug?: string } | undefined;
    if (fetcherData?.classroomSlug) {
      navigate(`/admin/${fetcherData.classroomSlug}/dashboard`);
    }
  }, [fetcher!.data, navigate]);

  // Compute slug preview from watched form values
  const slugPreview = formValues.name ? slugify(formValues.name) : '';
  const slugOverride = (formValues as { slug?: string }).slug;
  const effectiveSlug = slugOverride && slugOverride.length > 0 ? slugOverride : slugPreview;

  // Content repo: manual override when set, else `content-{namespace}` where
  // the namespace is the org-prefix-stripped slug (mirrors the server's
  // fallback so the preview always shows what an untouched submit would create).
  const selectedOrgLogin = gitOrgs.find(o => o.id === formValues.git_org_id)?.login ?? '';
  const namespaceSuggestion =
    effectiveSlug && selectedOrgLogin
      ? suggestContentNamespace({ orgLogin: selectedOrgLogin, slug: effectiveSlug })
      : effectiveSlug;
  const contentRepoSuggestion = namespaceSuggestion
    ? defaultContentRepoName(namespaceSuggestion)
    : '';
  const contentRepoOverride = (formValues as { content_repo?: string }).content_repo;
  const effectiveContentRepo =
    contentRepoOverride && contentRepoOverride.length > 0
      ? contentRepoOverride
      : contentRepoSuggestion;

  // Debounced availability check (shared with StepBasicInfo via props)
  const availabilityFetcher = useFetcher<{
    slug_available: boolean;
    slug_suggestion?: string;
  }>();
  const lastQueriedRef = useRef<string>('');
  useEffect(() => {
    if (!formValues.git_org_id || !effectiveSlug) return;
    const key = `${formValues.git_org_id}::${effectiveSlug}`;
    if (lastQueriedRef.current === key) return;
    const handle = setTimeout(() => {
      lastQueriedRef.current = key;
      const params = new URLSearchParams({
        git_org_id: formValues.git_org_id,
        slug: effectiveSlug,
      });
      availabilityFetcher.load(`/api/classrooms/availability?${params.toString()}`);
    }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formValues.git_org_id, effectiveSlug]);

  const slugIsTaken =
    !!availabilityFetcher.data &&
    availabilityFetcher.data.slug_available === false &&
    availabilityFetcher.state === 'idle';

  const handleNext = async () => {
    if (currentStep === 0) {
      const isValid = await trigger(['git_org_id', 'name']);
      if (isValid && !slugIsTaken) {
        setCurrentStep(1);
      }
    } else if (currentStep === 1) {
      setCurrentStep(2);
    }
  };

  const handlePrev = () => {
    setCurrentStep(prev => Math.max(0, prev - 1));
  };

  const handleSubmit = async () => {
    const values = getValues();

    // Build import config if applicable
    let importConfig = null;
    const anySelection = selectedModules.size > 0 || Object.values(importSelections).some(Boolean);
    if (importEnabled && sourceClassroomId && anySelection) {
      const { pages, slides, modules, duplicateTemplates, ...config } = importSelections;
      importConfig = {
        sourceClassroomId,
        repositories: Array.from(selectedModules.entries()).map(([id, cfg]) => ({
          id,
          includeQuizzes: cfg.includeQuizzes || false,
        })),
        config,
        content: { pages, slides, modules, duplicateTemplates },
      };
    }

    notify(ActionTypes.CREATE_CLASSROOM, 'Creating classroom...');

    fetcher!.submit(
      { ...values, slug: effectiveSlug, content_repo: effectiveContentRepo, importConfig },
      {
        method: 'post',
        action: '/create-classroom',
        encType: 'application/json',
      }
    );
  };

  const sourceClassroom = importableClassrooms.find(c => c.id === sourceClassroomId);

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-xl font-semibold mb-6 dark:text-gray-100">Create New Classroom</h1>

      {gitOrgs.length === 0 ? (
        isWaitingForOrg ? (
          // A just-installed org is still being provisioned/synced. Show a loading
          // state (and keep polling) rather than the misleading "no organizations"
          // message right after installing.
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Spin />
            <div className="mt-4 text-gray-500">Setting up your organization…</div>
          </div>
        ) : (
          <Alert
            type="warning"
            message="No GitHub Organizations Available"
            description={
              <div>
                <p className="mb-4">
                  You need to install the Classmoji GitHub App on a GitHub organization before you
                  can create a classroom.
                </p>
                <Button
                  type="link"
                  onClick={openInstallPopup}
                  loading={isRefreshing}
                  className="p-0"
                >
                  Install GitHub App on an Organization
                </Button>
              </div>
            }
          />
        )
      ) : (
        <Card>
          <Steps current={currentStep} items={STEPS} style={{ marginBottom: 24 }} size="small" />

          <FormProvider {...methods}>
            {currentStep === 0 && (
              <StepBasicInfo
                gitOrgs={gitOrgs}
                slugPreview={slugPreview}
                githubAppName={githubAppName}
                availability={availabilityFetcher.data}
                availabilityLoading={availabilityFetcher.state !== 'idle'}
                selectedOrgLogin={selectedOrgLogin}
                contentRepoSuggestion={contentRepoSuggestion}
                effectiveContentRepo={effectiveContentRepo}
              />
            )}

            {currentStep === 1 && (
              <StepImportModules
                importableClassrooms={importableClassrooms}
                importEnabled={importEnabled}
                setImportEnabled={setImportEnabled}
                sourceClassroomId={sourceClassroomId}
                setSourceClassroomId={setSourceClassroomId}
                selectedModules={selectedModules}
                setSelectedModules={setSelectedModules}
                importSelections={importSelections}
                setImportSelections={setImportSelections}
              />
            )}

            {currentStep === 2 && (
              <StepReview
                formValues={formValues}
                gitOrgs={gitOrgs}
                slugPreview={effectiveSlug}
                contentRepoName={selectedOrgLogin ? effectiveContentRepo : null}
                importEnabled={importEnabled}
                sourceClassroom={sourceClassroom}
                selectedModules={selectedModules}
                importSelections={importSelections}
              />
            )}

            <div className="flex justify-between mt-8">
              <div>{currentStep > 0 && <Button onClick={handlePrev}>Previous</Button>}</div>
              <div className="flex gap-3">
                {currentStep === 0 && (
                  <Button onClick={() => navigate('/select-organization')}>Cancel</Button>
                )}
                {currentStep < 2 ? (
                  <Button
                    type="primary"
                    onClick={handleNext}
                    disabled={currentStep === 0 && slugIsTaken}
                  >
                    Next
                  </Button>
                ) : (
                  <Button
                    type="primary"
                    onClick={handleSubmit}
                    loading={fetcher!.state === 'submitting'}
                  >
                    Create Classroom
                  </Button>
                )}
              </div>
            </div>
          </FormProvider>
        </Card>
      )}

      {gitOrgs.length > 0 && (
        <div className="mt-6 text-center">
          <Button type="link" onClick={openInstallPopup} loading={isRefreshing} className="text-sm">
            Install GitHub App on another organization
          </Button>
        </div>
      )}
    </div>
  );
};

export { action } from './action';

export default CreateClassroom;
