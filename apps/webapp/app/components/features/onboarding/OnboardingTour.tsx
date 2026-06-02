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

import { useEffect, useRef } from 'react';
import { useFetcher, useLocation, useNavigate } from 'react-router';
import { Tour, Button } from 'antd';
import type { TourProps } from 'antd';
import { useUser } from '~/hooks';
import useStore from '~/store';
import type { TourPhase } from '~/types';

/** Target a landing `data-onboarding` element; null -> antd renders centered. */
const target = (key: string) =>
  (() => document.querySelector<HTMLElement>(`[data-onboarding="${key}"]`)) as () => HTMLElement;

const LANDING_STEPS: NonNullable<TourProps['steps']> = [
  {
    title: 'Welcome to Classmoji 👋',
    description:
      'Classmoji is a Git-native learning platform for CS courses, similar to GitHub Classroom but built around how programming is actually taught and graded. This quick tour covers the basics on this screen first, then walks you through a sample course twice, once as the instructor and once as a student, so you see both sides.',
  },
  {
    title: 'Create a classroom',
    description:
      'A classroom is backed by a GitHub organization, and you can run several classrooms (for example, different semesters of the same course) under one org. To create one you pick an org where you are an admin and have the Classmoji GitHub app installed, then name the class; the URL slug is generated from the name and cannot be changed later.',
    target: target('new-class'),
    placement: 'bottom',
  },
  {
    title: 'Import an existing course',
    description:
      'Already taught a course in Classmoji? Start a new classroom from a previous one and bring its modules along. Imported content arrives with deadlines stripped and modules unpublished, so you can reuse coursework without exposing anything to students until you are ready.',
    target: target('import'),
    placement: 'bottom',
  },
  {
    title: 'Notifications',
    description:
      'The bell collects activity that needs your attention across your classrooms. Instructors see new submissions and grading to do, while students see released grades and new assignments, so important updates are in one place instead of buried in email.',
    target: target('bell'),
    placement: 'bottomRight',
  },
  {
    title: 'Your profile',
    description:
      'Open your profile to manage your account, sign out, and personalize the interface. This is where you set light or dark mode, an accent color, and other display preferences that follow you across every classroom.',
    target: target('profile'),
    placement: 'bottomRight',
  },
  {
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
  const active = tourPhase === 'landing' && onLanding;

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
      open={active}
      current={tourStep}
      onChange={setTourStep}
      onClose={endTour}
      onFinish={finishLanding}
      steps={LANDING_STEPS}
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
