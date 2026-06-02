/**
 * Landing phase of the guided "Take a tour" sequence.
 *
 * Mounted in root.tsx. Runs the landing-page walkthrough when the store
 * `tourPhase` is 'landing' (set by the landing "Take a tour" button via
 * startFullTour, or automatically on a user's first sign-in). On finish it hands
 * off to the instructor class tour by setting phase 'instructor' and navigating
 * into the hidden Example Course; InClassroomTour takes over from there, then the
 * student tour, then back to the landing. Skipping (the X) ends the sequence.
 *
 * First sign-in: a brand-new user (onboarding_completed_at == null) auto-starts
 * the full sequence once; the flag is stamped immediately so it never auto-runs
 * again. The landing "Take a tour" button replays the whole thing on demand.
 *
 * Resume: phase + step live in sessionStorage, so refreshing mid-tour (here on the
 * landing, or inside the Example Course) picks up at the same step instead of
 * restarting from the top or dropping you out.
 *
 * Copy is sourced from https://classmoji.io/docs and matches the current flow.
 */

import { useEffect, useRef, useState } from 'react';
import { useFetcher, useLocation, useNavigate } from 'react-router';
import { Tour, Button } from 'antd';
import type { TourProps } from 'antd';
import { useUser } from '~/hooks';
import useStore from '~/store';
import type { TourPhase } from '~/types';

/** Target a landing `data-onboarding` element; null -> antd renders centered. */
const target = (key: string) =>
  (() => document.querySelector<HTMLElement>(`[data-onboarding="${key}"]`)) as () => HTMLElement;

type Placement = NonNullable<TourProps['steps']>[number]['placement'];

interface LandingStep {
  /** Account route this step lives on; the tour navigates here when it opens. */
  link: string;
  /** data-onboarding key to spotlight (omit -> centered informational step). */
  onboarding?: string;
  placement?: Placement;
  title: string;
  description: string;
}

const SELECT_ORG = '/select-organization';

const LANDING_STEPS: LandingStep[] = [
  {
    link: SELECT_ORG,
    title: 'Welcome to Classmoji',
    description:
      'Classmoji is a Git-native learning platform for CS courses, similar to GitHub Classroom but built around how programming is actually taught and graded. This quick tour covers your account and this screen first, then walks you through a sample course twice, once as the instructor and once as a student, so you see both sides. Tip: use the Right and Left arrow keys to move to the next and previous step.',
  },
  {
    link: SELECT_ORG,
    onboarding: 'new-class',
    placement: 'bottom',
    title: 'Create a classroom',
    description:
      'A classroom is backed by a GitHub organization, and you can run several classrooms (for example, different semesters of the same course) under one org. To create one you pick an org where you are an admin and have the Classmoji GitHub app installed, then name the class; the URL slug is generated from the name and cannot be changed later.',
  },
  {
    link: SELECT_ORG,
    onboarding: 'import',
    placement: 'bottom',
    title: 'Import an existing course',
    description:
      'Already taught a course in Classmoji? Start a new classroom from a previous one and bring its repositories along. Imported content arrives with deadlines stripped and repositories unpublished, so you can reuse coursework without exposing anything to students until you are ready.',
  },
  {
    link: SELECT_ORG,
    onboarding: 'bell',
    placement: 'bottomRight',
    title: 'Notifications',
    description:
      'The bell collects activity that needs your attention across your classrooms. Instructors see new submissions and grading to do, while students see released grades and new assignments, so important updates are in one place instead of buried in email.',
  },
  {
    link: SELECT_ORG,
    onboarding: 'profile',
    placement: 'bottomRight',
    title: 'Your profile',
    description: 'Open your profile to reach your account settings and sign out.',
  },
  {
    link: '/settings/general',
    onboarding: 'settings-general',
    placement: 'right',
    title: 'Your account',
    description:
      'Your profile basics, name, email, and GitHub username, live on the General tab. They are synced from GitHub and shown read-only here.',
  },
  {
    link: '/settings/notifications',
    onboarding: 'settings-notifications',
    placement: 'left',
    title: 'Notification preferences',
    description:
      'In your account settings, the Notifications tab lets you choose exactly which events email you. Toggle any of them on or off here.',
  },
  {
    link: '/settings/billing',
    onboarding: 'settings-billing',
    placement: 'bottom',
    title: 'Plans and billing',
    description:
      'Classmoji has a free tier and a paid Pro tier (Pro unlocks AI quizzes and more). This badge shows your current plan, and you can upgrade or manage billing from the Billing tab.',
  },
  {
    link: SELECT_ORG,
    title: 'Step into a sample course',
    description:
      'Next you will enter a built-in example course to see Classmoji in action. You will tour it first as the instructor, then as a student, so you understand exactly what each role can do and what your students will experience.',
  },
];

export function OnboardingTour() {
  const { user } = useUser();
  const location = useLocation();
  const navigate = useNavigate();
  const fetcher = useFetcher();

  const tourPhase = useStore(s => s.tourPhase);
  const tourStep = useStore(s => s.tourStep);
  const startFullTour = useStore(s => s.startFullTour);
  const setTourPhase = useStore(s => s.setTourPhase);
  const setTourStep = useStore(s => s.setTourStep);
  const endTour = useStore(s => s.endTour);

  const initRef = useRef(false);

  const onLanding = location.pathname.startsWith('/select-organization');
  // The landing tour now also visits the user's account settings, so it stays
  // active across /select-organization and /settings.
  const onAccountRoute = onLanding || location.pathname.startsWith('/settings');
  const active = tourPhase === 'landing' && onAccountRoute;

  // Initialize the landing tour exactly once on mount, two ways in (in order):
  //  - Resume: a landing tour was already running and you refreshed — pick it back
  //    up at the same step (phase + step persisted in sessionStorage).
  //  - First sign-in: a brand-new user auto-starts the full sequence, and we stamp
  //    the onboarding flag immediately so it never auto-runs again.
  // Folding both into one effect (instead of two) avoids a resume-vs-auto-start
  // race on mount. initRef is per-mount, so a client nav won't re-init, but a full
  // refresh (fresh mount) will — which is exactly when we want to resume.
  useEffect(() => {
    if (initRef.current) return;
    if (!user || !onLanding || tourPhase !== 'idle') return;
    initRef.current = true;

    let saved: { phase?: TourPhase; step?: number } | null = null;
    try {
      saved = JSON.parse(sessionStorage.getItem('cm-tour') || 'null');
    } catch {
      saved = null;
    }
    if (saved?.phase === 'landing') {
      setTourPhase('landing');
      setTourStep(typeof saved.step === 'number' ? saved.step : 0);
      return;
    }

    if (!user.onboarding_completed_at) {
      startFullTour();
      fetcher.submit(null, { method: 'POST', action: '/api/onboarding/complete' });
    }
  }, [user, onLanding, tourPhase, startFullTour, setTourPhase, setTourStep, fetcher]);

  // Each step lives on a specific account route; navigate there when it opens.
  useEffect(() => {
    if (!active) return;
    const want = LANDING_STEPS[tourStep]?.link;
    if (want && location.pathname !== want) navigate(want);
  }, [active, tourStep, location.pathname, navigate]);

  // Re-resolve the spotlight target after navigation/mount so antd anchors to it
  // instead of centering (the target may be on a just-navigated-to page).
  const [, setResolveNonce] = useState(0);
  useEffect(() => {
    if (!active) return;
    const key = LANDING_STEPS[tourStep]?.onboarding;
    if (!key) return;
    const sel = `[data-onboarding="${key}"]`;
    let tries = 0;
    const id = window.setInterval(() => {
      tries += 1;
      const el = document.querySelector(sel);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        setResolveNonce(n => n + 1);
        window.dispatchEvent(new Event('resize'));
        window.clearInterval(id);
      } else if (tries >= 14) {
        window.clearInterval(id);
      }
    }, 150);
    return () => window.clearInterval(id);
  }, [active, tourStep, location.pathname]);

  // Slug of the hidden Example Course (the user owns it).
  const exampleSlug =
    user?.memberships?.find(
      m => (m.organization as { is_example?: boolean }).is_example && m.role === 'OWNER'
    )?.organization?.login ?? null;

  const finishLanding = () => {
    if (exampleSlug) {
      setTourStep(0); // instructor tour starts at its first step
      setTourPhase('instructor');
      navigate(`/admin/${exampleSlug}/dashboard`);
    } else {
      endTour();
    }
  };

  // The final landing step leads into the class tour, so replace the default
  // "Finish" with an explicit choice. NOTE: antd only honors the Tour-level
  // actionsRender (the per-step one is ignored), so branch on the current step.
  const lastStep = LANDING_STEPS.length - 1;

  // Arrow keys drive the tour: Right = Next ("Let's go!" on the last step),
  // Left = Previous. Ignored while focus is in a text field.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      e.preventDefault();
      if (e.key === 'ArrowLeft') {
        if (tourStep > 0) setTourStep(tourStep - 1);
      } else if (tourStep < lastStep) {
        setTourStep(tourStep + 1);
      } else {
        finishLanding();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, tourStep, lastStep, finishLanding, setTourStep]);

  if (!active) return null;

  return (
    <Tour
      rootClassName="cm-tour"
      open={active}
      current={tourStep}
      onChange={setTourStep}
      onClose={endTour}
      onFinish={finishLanding}
      steps={LANDING_STEPS.map(s => ({
        title: s.title,
        description: s.description,
        target: s.onboarding ? target(s.onboarding) : undefined,
        placement: s.placement,
        mask: s.onboarding ? undefined : { color: 'rgba(0, 0, 0, 0.8)' },
      }))}
      indicatorsRender={(current, total) => (
        <div
          style={{
            width: '100%',
            height: 6,
            borderRadius: 9999,
            background: 'rgba(128,128,128,0.2)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${((current + 1) / total) * 100}%`,
              background: 'var(--accent, #c0392b)',
              borderRadius: 9999,
              transition: 'width 0.5s cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          />
        </div>
      )}
      actionsRender={(origin, info) =>
        info.current === lastStep ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="small" onClick={endTour}>
              Skip for now
            </Button>
            <Button size="small" type="primary" onClick={finishLanding}>
              Let’s go!
            </Button>
          </div>
        ) : (
          origin
        )
      }
      disabledInteraction
      // Instant: rc-tour's useTarget reads getBoundingClientRect() synchronously
      // right after scrolling, so a smooth (async) scroll mis-anchors the spotlight.
      scrollIntoViewOptions={{ block: 'center', behavior: 'instant' }}
      zIndex={2000}
    />
  );
}

export default OnboardingTour;
