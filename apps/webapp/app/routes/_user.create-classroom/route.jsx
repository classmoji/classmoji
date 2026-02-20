import { redirect, useNavigate } from 'react-router';
import { useState, useEffect } from 'react';
import { useForm, FormProvider } from 'react-hook-form';
import { Button, Card, Alert, Steps } from 'antd';

import { getAuthSession, clearRevokedToken } from '@classmoji/auth/server';
import { useGlobalFetcher, useGitHubAppInstallPopup } from '~/hooks';
import { ClassmojiService, GitHubProvider } from '@classmoji/services';
import { ActionTypes } from '~/constants';
import prisma from '@classmoji/database';

import StepBasicInfo from './StepBasicInfo';
import StepImportModules from './StepImportModules';
import StepReview from './StepReview';
import { slugify, getTermCode, STEPS } from './utils';

export const loader = async ({ request }) => {
  const authData = await getAuthSession(request);

  if (!authData?.token) return redirect('/');

  const octokit = GitHubProvider.getUserOctokit(authData.token);

  // Get authenticated user
  let authenticatedUser;
  try {
    const { data } = await octokit.rest.users.getAuthenticated();
    authenticatedUser = data;
  } catch (error) {
    // If bad credentials, clear revoked token from cache AND database
    if (error.status === 401 || error.message?.includes('Bad credentials')) {
      await clearRevokedToken(authData.userId);
      return redirect('/');
    }
    throw error;
  }

  const user = await ClassmojiService.user.findByLogin(authenticatedUser.login);

  if (!user) {
    return redirect('/registration');
  }

  // Get GitHub organizations the user belongs to
  let userOrgs = [];
  try {
    const { data } = await octokit.rest.orgs.listForAuthenticatedUser();
    userOrgs = data || [];
  } catch (error) {
    console.error('Error fetching user orgs:', error.message);
  }

  // Get provider IDs of user's GitHub orgs
  const providerIds = userOrgs.map(org => String(org.id));

  // Cross-reference with our GitOrganization table - only show orgs with active GitHub App installations
  const gitOrgs = await prisma.gitOrganization.findMany({
    where: {
      provider: 'GITHUB',
      provider_id: { in: providerIds },
      github_installation_id: { not: null }, // Only orgs with active installations
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
  });

  // Enrich gitOrgs with avatar URLs from GitHub
  const gitOrgsWithAvatars = gitOrgs.map(org => {
    const githubOrg = userOrgs.find(o => String(o.id) === org.provider_id);
    return {
      ...org,
      avatar_url: githubOrg?.avatar_url || null,
    };
  });

  // Get all classrooms where user is OWNER (for import source)
  const ownedClassrooms = await prisma.classroom.findMany({
    where: {
      memberships: {
        some: {
          user_id: user.id,
          role: 'OWNER',
        },
      },
    },
    select: {
      id: true,
      slug: true,
      name: true,
      term: true,
      year: true,
      git_organization: {
        select: {
          login: true,
          avatar_url: true,
        },
      },
      modules: {
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
  });

  return {
    user,
    gitOrgs: gitOrgsWithAvatars,
    ownedClassrooms,
    githubAppName: process.env.GITHUB_APP_NAME,
  };
};

const CreateClassroom = ({ loaderData }) => {
  const { gitOrgs, ownedClassrooms, githubAppName } = loaderData;
  const navigate = useNavigate();
  const { fetcher, notify } = useGlobalFetcher();
  const { openInstallPopup, isRefreshing } = useGitHubAppInstallPopup(githubAppName);

  const currentYear = new Date().getFullYear();
  const years = [currentYear - 1, currentYear, currentYear + 1, currentYear + 2];

  // React Hook Form - persists values across step changes
  const methods = useForm({
    defaultValues: {
      git_org_id: '',
      name: '',
      term: '',
      year: currentYear,
    },
  });

  const { watch, trigger, getValues } = methods;
  const formValues = watch();

  // Stepper state
  const [currentStep, setCurrentStep] = useState(0);

  // Import state
  const [importEnabled, setImportEnabled] = useState(false);
  const [sourceClassroomId, setSourceClassroomId] = useState(null);
  const [selectedModules, setSelectedModules] = useState(new Map());

  // Navigate to new classroom on success
  useEffect(() => {
    if (fetcher.data?.classroomSlug) {
      navigate(`/admin/${fetcher.data.classroomSlug}/dashboard`);
    }
  }, [fetcher.data, navigate]);

  // Compute slug preview from watched form values
  const slugPreview = (() => {
    const { name, term, year } = formValues;
    if (name && term && year) {
      const termCode = getTermCode(term, year);
      return `${slugify(name)}-${termCode}`;
    } else if (name) {
      return slugify(name);
    }
    return '';
  })();

  const handleNext = async () => {
    if (currentStep === 0) {
      const isValid = await trigger(['git_org_id', 'name', 'term', 'year']);
      if (isValid) {
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
    if (importEnabled && sourceClassroomId && selectedModules.size > 0) {
      importConfig = {
        sourceClassroomId,
        modules: Array.from(selectedModules.entries()).map(([id, config]) => ({
          id,
          includeQuizzes: config.includeQuizzes || false,
        })),
      };
    }

    notify(ActionTypes.CREATE_CLASSROOM, 'Creating classroom...');

    fetcher.submit(
      { ...values, importConfig },
      {
        method: 'post',
        action: '/create-classroom',
        encType: 'application/json',
      }
    );
  };

  const sourceClassroom = ownedClassrooms.find(c => c.id === sourceClassroomId);

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-6 dark:text-gray-100">Create New Classroom</h1>

      {gitOrgs.length === 0 ? (
        <>
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
        </>
      ) : (
        <Card>
          <Steps
            current={currentStep}
            items={STEPS}
            style={{ marginBottom: 24 }}
            size="small"
          />

          <FormProvider {...methods}>
            {currentStep === 0 && (
              <StepBasicInfo
                gitOrgs={gitOrgs}
                slugPreview={slugPreview}
                years={years}
                githubAppName={githubAppName}
              />
            )}

            {currentStep === 1 && (
              <StepImportModules
                ownedClassrooms={ownedClassrooms}
                importEnabled={importEnabled}
                setImportEnabled={setImportEnabled}
                sourceClassroomId={sourceClassroomId}
                setSourceClassroomId={setSourceClassroomId}
                selectedModules={selectedModules}
                setSelectedModules={setSelectedModules}
              />
            )}

            {currentStep === 2 && (
              <StepReview
                formValues={formValues}
                gitOrgs={gitOrgs}
                slugPreview={slugPreview}
                importEnabled={importEnabled}
                sourceClassroom={sourceClassroom}
                selectedModules={selectedModules}
              />
            )}

            <div className="flex justify-between mt-8">
              <div>
                {currentStep > 0 && (
                  <Button onClick={handlePrev}>Previous</Button>
                )}
              </div>
              <div className="flex gap-3">
                {currentStep === 0 && (
                  <Button onClick={() => navigate('/select-organization')}>Cancel</Button>
                )}
                {currentStep < 2 ? (
                  <Button type="primary" onClick={handleNext}>
                    Next
                  </Button>
                ) : (
                  <Button
                    type="primary"
                    onClick={handleSubmit}
                    loading={fetcher.state === 'submitting'}
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
          <Button
            type="link"
            onClick={openInstallPopup}
            loading={isRefreshing}
            className="text-sm"
          >
            Install GitHub App on another organization
          </Button>
        </div>
      )}
    </div>
  );
};

export { action } from './action';

export default CreateClassroom;
