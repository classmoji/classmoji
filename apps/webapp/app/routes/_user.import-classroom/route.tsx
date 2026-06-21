import { redirect, useFetcher, useNavigate } from 'react-router';
import { useState, useEffect } from 'react';
import { Card, Steps, Button, Alert } from 'antd';

import { getAuthSession } from '@classmoji/auth/server';

import StepConnect from './StepConnect';
import StepSelectClassrooms from './StepSelectClassrooms';
import StepReview from './StepReview';
import StepProgress from './StepProgress';
import { slugify, type ListedClassroom } from './utils';
import type { Route } from './+types/route';

const STEPS = [{ title: 'Connect' }, { title: 'Select' }, { title: 'Review' }, { title: 'Import' }];

export const loader = async ({ request }: Route.LoaderArgs) => {
  const authData = await getAuthSession(request);
  if (!authData) return redirect('/');
  return {
    triggerConfigured: Boolean(process.env.TRIGGER_SECRET_KEY || process.env.TRIGGER_ACCESS_TOKEN),
  };
};

interface TriggerSession {
  accessToken: string;
  id: string;
  expected: number;
  singleSlug: string | null;
}

interface ImportActionData {
  error?: string;
  triggerSession?: TriggerSession;
}

const ImportClassroom = ({ loaderData }: Route.ComponentProps) => {
  const navigate = useNavigate();
  const fetcher = useFetcher<ImportActionData>();
  const { triggerConfigured } = loaderData;

  const [currentStep, setCurrentStep] = useState(0);
  const [classrooms, setClassrooms] = useState<ListedClassroom[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [slugByClassroom, setSlugByClassroom] = useState<Map<number, string>>(new Map());

  const data = fetcher.data;
  const submitting = fetcher.state === 'submitting';
  const session = data?.triggerSession;

  // When phase-1 list loads, seed selection/slugs and move to the picker.
  const handleClassrooms = (loaded: ListedClassroom[]) => {
    setClassrooms(loaded);
    setSelectedIds(
      new Set(loaded.filter(c => c.organization && !c.alreadyImported).map(c => c.githubId))
    );
    setSlugByClassroom(new Map(loaded.map(c => [c.githubId, slugify(c.name)])));
    if (loaded.length > 0) setCurrentStep(1);
  };

  const selectedClassrooms = classrooms.filter(c => selectedIds.has(c.githubId));

  const handleImport = () => {
    const selections = selectedClassrooms.map(c => ({
      classroomId: c.githubId,
      name: c.name,
      slug: slugByClassroom.get(c.githubId) || slugify(c.name),
    }));
    fetcher.submit({ selections } as unknown as Parameters<typeof fetcher.submit>[0], {
      method: 'post',
      action: '/import-classroom',
      encType: 'application/json',
    });
  };

  // Advance to the live-progress step once the jobs are triggered.
  useEffect(() => {
    if (session) setCurrentStep(3);
  }, [session]);

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-xl font-semibold mb-6 dark:text-gray-100">
        Import from GitHub Classroom
      </h1>

      <Card>
        <Steps current={currentStep} items={STEPS} size="small" style={{ marginBottom: 24 }} />

        {!triggerConfigured && (
          <Alert
            className="mb-4"
            type="warning"
            showIcon
            message="Imports are unavailable"
            description="The background job service (Trigger.dev) isn’t configured in this environment, so classroom imports can’t run here."
          />
        )}

        {currentStep === 0 && (
          <StepConnect onLoaded={handleClassrooms} hasLoaded={classrooms.length > 0} />
        )}

        {currentStep === 1 && (
          <StepSelectClassrooms
            classrooms={classrooms}
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
          />
        )}

        {currentStep === 2 && (
          <StepReview
            classrooms={selectedClassrooms}
            slugByClassroom={slugByClassroom}
            onSlugChange={(id, slug) => setSlugByClassroom(prev => new Map(prev).set(id, slug))}
          />
        )}

        {currentStep === 3 && session && (
          <StepProgress
            accessToken={session.accessToken}
            sessionId={session.id}
            expected={session.expected}
            singleSlug={session.singleSlug}
          />
        )}

        {data?.error && <Alert className="mt-4" type="error" showIcon message={data.error} />}

        {currentStep < 3 && (
          <div className="flex justify-between mt-8">
            <div>
              {currentStep > 0 && (
                <Button onClick={() => setCurrentStep(s => s - 1)} disabled={submitting}>
                  Previous
                </Button>
              )}
            </div>
            <div className="flex gap-3">
              <Button onClick={() => navigate('/')} disabled={submitting}>
                Cancel
              </Button>
              {currentStep === 1 && (
                <Button
                  type="primary"
                  disabled={selectedIds.size === 0}
                  onClick={() => setCurrentStep(2)}
                >
                  Next
                </Button>
              )}
              {currentStep === 2 && (
                <Button
                  type="primary"
                  loading={submitting}
                  disabled={selectedClassrooms.length === 0 || !triggerConfigured}
                  onClick={handleImport}
                >
                  Import {selectedClassrooms.length} classroom
                  {selectedClassrooms.length === 1 ? '' : 's'}
                </Button>
              )}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
};

export { action } from './action';

export default ImportClassroom;
