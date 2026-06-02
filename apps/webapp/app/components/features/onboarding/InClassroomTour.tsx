/**
 * Instructor + student phases of the guided "Take a tour" sequence.
 *
 * Mounted in root.tsx. Driven by the store `tourPhase`:
 *  - 'instructor' runs the owner walkthrough under /admin/<example>,
 *  - 'student' runs the student walkthrough under /student/<example>.
 * Each feature gets a nav step (spotlights its always-mounted sidebar item) and,
 * where there's a key action/element, an in-page step that spotlights it. The
 * instructor tour hands off to the student tour (its last step shows Skip/Next,
 * not Finish); the student tour ends the sequence and returns to the landing.
 *
 * Reached only as part of the "Take a tour" sequence (the Example Course is
 * hidden from the grid and the org switcher), so there is no standalone
 * auto-start here, the landing phase hands off into it.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useLocation, useFetcher } from 'react-router';
import { Tour, Button } from 'antd';
import type { TourProps } from 'antd';
import useStore from '~/store';
import type { TourPhase } from '~/types';

type Placement = NonNullable<TourProps['steps']>[number]['placement'];

/** Spotlight a sidebar nav item by its route link (always mounted in the shell). */
const navTarget = (link: string) =>
  (() => document.querySelector<HTMLElement>(`[data-tour-nav="${link}"]`)) as () => HTMLElement;
/** Spotlight an arbitrary element by selector (null -> antd renders centered). */
const selTarget = (selector: string) =>
  (() => document.querySelector<HTMLElement>(selector)) as () => HTMLElement;

interface FeatureStep {
  /** Route to navigate to / be on. */
  link?: string;
  /** Explicit selector to anchor (overrides the nav item), e.g. an in-page element. */
  selector?: string;
  placement?: Placement;
  title: string;
  description: string;
}

const OWNER_STEPS: FeatureStep[] = [
  {
    link: '/dashboard',
    title: 'Instructor dashboard',
    description:
      'The dashboard is your home base for running the class and the first thing you see when you open a classroom. It summarizes the current state of the course and links out to everything in the left sidebar, so you start each day knowing what needs attention.',
  },
  {
    link: '/dashboard',
    selector: '[data-tour="dashboard-stats"]',
    placement: 'bottom',
    title: 'Class stats at a glance',
    description:
      'These cards give you the health of the course in one look: how many students are enrolled, the submission rate, how much work is late, and how much grading is still left. They update as students submit and you grade, so you can spot problems early.',
  },
  {
    link: '/modules',
    title: 'Modules',
    description:
      'Modules are the units of coursework in your class, such as a lab, a project, or a weekly problem set. Each module is backed by a GitHub repository created from a template, and when you publish it Classmoji copies that repo to every student, or every team for group work.',
  },
  {
    link: '/modules',
    selector: '[data-tour="modules-new"]',
    placement: 'bottom',
    title: 'Create a module',
    description:
      'Use New module to add a unit of work backed by a template repository. The assignments inside become GitHub issues that Classmoji opens in each student’s copy of the repo, and you control release dates, due dates, and weighting per assignment.',
  },
  {
    link: '/students',
    title: 'Your roster',
    description:
      'The roster lists everyone enrolled along with their status. Students show as Pending until they accept the GitHub organization invite, then become Active with full access to their repos. This is where you review enrollment and remove students or revoke invites.',
  },
  {
    link: '/students',
    selector: '[data-tour="students-add"]',
    placement: 'bottom',
    title: 'Add students',
    description:
      'Add Students lets you paste a list of names and emails, one per line, often straight from your school’s system. Existing Classmoji users are enrolled right away, while new users get an email to join first, and on their first visit students accept a GitHub org invite to get repo access.',
  },
  {
    link: '/teams',
    title: 'Teams for group work',
    description:
      'Teams let you run group projects instead of individual work. A group module gives each team a single shared repository rather than one repo per student, and you can assign teams yourself or let students form their own, plus set a maximum team size.',
  },
  {
    link: '/assistants',
    title: 'Teaching assistants',
    description:
      'Assistants help you run and grade the class. You add a TA by GitHub username, then assign them specific submissions to grade from the module view. This spreads grading across your staff so it scales even in a large course.',
  },
  {
    link: '/grades',
    title: 'The gradebook',
    description:
      'The Grades page is a full gradebook with students as rows and assignments as columns. Grades are hidden from students by default and released per assignment when you are ready, and assignment grades roll up into module grades and a final grade using the weighting you configure.',
  },
  {
    link: '/grades',
    selector: '[data-tour="grades-view-toggle"]',
    placement: 'bottom',
    title: 'Emoji grading',
    description:
      'Classmoji grades with emojis instead of bare numbers, and each emoji maps to a numeric value from 0 to 100 that you set in settings. A submission’s grade is the average of the emoji values you apply. Use this toggle to read the gradebook as expressive emoji or as the exact numbers behind them.',
  },
  {
    link: '/tokens',
    title: 'Extension tokens',
    description:
      'Tokens are a self-service deadline-extension system that replaces one-off email requests. You give students a balance of tokens, and they spend them to buy extra hours on a past-due assignment without asking you each time. This page shows the full token log for the class.',
  },
  {
    link: '/tokens',
    selector: '[data-tour="tokens-assign"]',
    placement: 'bottom',
    title: 'Hand out tokens',
    description:
      'Assign Tokens lets you grant tokens to one student or the whole class at once. Students spend them to extend their own deadlines, and you set the price, the tokens per hour of extension, in Settings under Extension. Allocations take effect immediately and appear in the token log.',
  },
  {
    link: '/calendar',
    title: 'Course calendar',
    description:
      'The calendar holds your course schedule in one place: lectures, labs, office hours, and assessments. It gives you and your students a shared view of what is happening and when, alongside the deadlines coming from your modules.',
  },
  {
    link: '/calendar',
    selector: '[data-tour="calendar-add-event"]',
    placement: 'bottom',
    title: 'Schedule events',
    description:
      'Add Event creates calendar entries for lectures, labs, office hours, exams, and anything else students should know about. Students can subscribe to the full calendar from their own calendar app, so updates flow straight to their devices.',
  },
  {
    link: '/pages',
    title: 'Pages',
    description:
      'Pages are course material you write and publish for students, such as the syllabus, lecture notes, assignment specs, or reference guides. They are served through GitHub Pages, so your content lives in the same Git-native setup as the rest of the class.',
  },
  {
    link: '/repositories',
    title: 'Repositories',
    description:
      'This page mirrors every student and team repository created from your published modules, pulled from your GitHub organization, so you can jump to any repo and confirm copies were created. This example course uses mock data with no real GitHub org, so the list here is empty.',
  },
  {
    link: '/repo-health',
    title: 'Repo health',
    description:
      'Repo health surfaces patterns across student repositories, including commit timelines, contributor breakdowns, and flags for unusual activity, which helps you spot students who are stuck. Because this example course has no real repos, this view is empty here.',
  },
  {
    link: '/settings/general',
    title: 'Class settings',
    description:
      'Settings is where you tune how the class works: the emoji-to-number grade scale and letter-grade ranges, the token cost per hour of extension, late penalties, team formation rules, and more. These choices drive grading and deadlines across every module.',
  },
  {
    link: '/settings/general',
    selector: '[data-tour="settings-status"]',
    placement: 'bottom',
    title: 'Read-only and archive',
    description:
      'From settings you can also change the overall status of the class. Flipping it to read-only or unpublished freezes changes, which is useful at the end of a term or while you prepare the next cohort without disrupting the current one.',
  },
  {
    title: 'Ask Moji',
    description:
      'Ask Moji is an in-class AI assistant that answers questions about your syllabus and course logistics. It is optional and you turn it on per class in settings, after which it appears in your sidebar to help you and your students with quick questions.',
  },
  {
    title: 'That’s the instructor side',
    description:
      'You have seen how an instructor sets up modules, grades with emoji, manages the roster, and runs the class. Next we will reopen the same example course as a student so you can see exactly what your students see. Click Next to switch.',
  },
];

const STUDENT_STEPS: FeatureStep[] = [
  {
    link: '/dashboard',
    title: 'Student dashboard',
    description:
      'This is the dashboard you land on as a student when you open a class. It pulls together what matters most right now so you can get oriented quickly: your current work, upcoming deadlines, and recent activity from your instructor.',
  },
  {
    link: '/dashboard',
    selector: '[data-tour="dashboard-spotlight"]',
    placement: 'bottom',
    title: 'What’s next',
    description:
      'This spotlight highlights your current module and what is coming up next so you always know what to work on. It saves you from hunting through every module to find the next thing due.',
  },
  {
    link: '/modules',
    title: 'Your modules',
    description:
      'Modules are the units of coursework in the class, like labs, projects, and problem sets. Each module is backed by your own GitHub repository, and the assignments inside it are GitHub issues you complete in that repo.',
  },
  {
    link: '/modules',
    selector: '[data-tour="modules-card"]',
    placement: 'bottom',
    title: 'Inside a module',
    description:
      'Each module is one of your GitHub repositories of coursework. Expand a module to see its assignments and the resources your instructor attached, track how far along you are, then open the repo to start working.',
  },
  {
    link: '/assignments',
    title: 'Assignments',
    description:
      'This page lists all of your assignments across every module in one place. Each assignment is a GitHub issue in your repo, with a due date and its current status, so you can see everything you owe without opening each module separately.',
  },
  {
    link: '/assignments',
    selector: '[data-tour="assignments-progress"]',
    placement: 'bottom',
    title: 'Your progress',
    description:
      'This bar shows how much of your work is submitted and graded at a glance, and the tabs below switch between current and completed assignments. You submit an assignment by closing its GitHub issue in your repo, which marks it as turned in here automatically.',
  },
  {
    link: '/tokens',
    title: 'Your tokens',
    description:
      'Tokens are how you give yourself extra time on a deadline without emailing your instructor. Your instructor grants you a balance, and once an assignment is past due you can spend tokens to extend it, paying a set number of tokens per hour.',
  },
  {
    link: '/tokens',
    selector: '[data-tour="tokens-log"]',
    placement: 'top',
    title: 'Your token ledger',
    description:
      'This ledger is the full history of your tokens: every grant you receive and every extension you buy, with your running balance. It keeps things transparent so you always know how many hours of extension you can still afford.',
  },
  {
    link: '/regrade-requests',
    title: 'Regrade requests',
    description:
      'If you think a grade is wrong, regrade requests are how you formally ask your instructor or TA to take another look. Your requests and their status live on this page, so you can follow up without chasing anyone over email.',
  },
  {
    link: '/regrade-requests',
    selector: '[data-tour="regrade-new"]',
    placement: 'bottom',
    title: 'Request a regrade',
    description:
      'Use this to open a new regrade request on an assignment you believe was marked incorrectly. Explain what you think is off, submit it, and your instructor or a TA will review the assignment and respond.',
  },
  {
    link: '/calendar',
    title: 'Course calendar',
    description:
      'The calendar shows the full course schedule: lectures, labs, office hours, and assessments your instructor has posted. You can subscribe to it from your own calendar app so events and changes sync automatically.',
  },
  {
    link: '/settings',
    title: 'Make it yours',
    description:
      'Settings let you personalize how Classmoji looks for you, including light or dark mode, an accent color, and a background. These are your own preferences and do not affect anyone else in the class.',
  },
  {
    title: 'Ask Moji',
    description:
      'Ask Moji is an in-class AI assistant for questions about the syllabus and course logistics. When your instructor has it enabled, you can ask it things like deadlines, policies, or where to find a resource and get a quick answer.',
  },
  {
    title: 'That’s the tour',
    description:
      'You have seen Classmoji from both the instructor and student sides. Click Finish to return to your classrooms. You can replay this walkthrough anytime using Take a tour.',
  },
];

export function InClassroomTour() {
  const classroom = useStore(s => s.classroom);
  const tourPhase = useStore(s => s.tourPhase);
  const tourStep = useStore(s => s.tourStep);
  const setTourPhase = useStore(s => s.setTourPhase);
  const setTourStep = useStore(s => s.setTourStep);
  const endTour = useStore(s => s.endTour);

  const navigate = useNavigate();
  const location = useLocation();
  const fetcher = useFetcher();

  // Bumped when a step's target finally mounts (deferred <Await> content), to
  // force a re-render so antd re-resolves target() and anchors instead of centering.
  const [, setResolveNonce] = useState(0);

  const phaseRole = tourPhase === 'instructor' ? 'OWNER' : tourPhase === 'student' ? 'STUDENT' : null;
  const pathPrefix =
    tourPhase === 'instructor' ? '/admin' : tourPhase === 'student' ? '/student' : null;
  const featureSteps = tourPhase === 'student' ? STUDENT_STEPS : OWNER_STEPS;
  const base = classroom?.slug && pathPrefix ? `${pathPrefix}/${classroom.slug}` : null;
  const onRoute = !!base && location.pathname.startsWith(base);
  const active = !!pathPrefix && !!classroom?.is_example && onRoute;

  // You're inside the Example Course with no active tour in memory. If a tour was
  // saved (you refreshed mid-tour), resume it where it left off so the modal comes
  // back in the same place. Otherwise (a direct visit with nothing saved) bounce
  // to the classes screen — the example course is only for the guided tour.
  useEffect(() => {
    if (tourPhase !== 'idle' || !classroom?.is_example) return;
    let saved: { phase?: TourPhase; step?: number } | null = null;
    try {
      saved = JSON.parse(sessionStorage.getItem('cm-tour') || 'null');
    } catch {
      saved = null;
    }
    // Only the in-classroom phases belong here; a saved 'landing' (or nothing)
    // means no in-classroom tour to resume, so bounce out instead.
    if (saved?.phase === 'instructor' || saved?.phase === 'student') {
      setTourPhase(saved.phase);
      setTourStep(typeof saved.step === 'number' ? saved.step : 0);
    } else {
      navigate('/select-organization', { replace: true });
    }
  }, [tourPhase, classroom, navigate, setTourPhase, setTourStep]);

  // Drive navigation: show each feature page (and keep in-page steps on it).
  useEffect(() => {
    if (!active || !base) return;
    const step = featureSteps[tourStep];
    if (!step?.link) return;
    const want = `${base}${step.link}`;
    if (location.pathname !== want) navigate(want);
  }, [active, tourStep, base, location.pathname, navigate, featureSteps]);

  // Wait for the current step's target to mount (some live behind deferred
  // <Await> boundaries), then scroll it into view and force a re-render so antd
  // anchors to it. Targets with no selector (centered steps) are skipped.
  useEffect(() => {
    if (!active) return;
    const step = featureSteps[tourStep];
    const sel = step?.selector ?? (step?.link ? `[data-tour-nav="${step.link}"]` : null);
    if (!sel) return;
    let tries = 0;
    const id = window.setInterval(() => {
      tries += 1;
      const el = document.querySelector(sel);
      if (el) {
        // Instant (not smooth): rc-tour's useTarget reads getBoundingClientRect()
        // synchronously right after scrolling, so a still-animating smooth scroll
        // leaves the spotlight pinned to the element's pre-scroll position (which,
        // after the scroll settles, is now over a *different* nav item).
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        setResolveNonce(n => n + 1);
        // useTarget only re-measures on target change or window resize, never on a
        // programmatic scroll — and our resolveNonce re-render resolves to the same
        // element ref, so it won't re-measure. Nudge it to re-read the settled rect.
        window.dispatchEvent(new Event('resize'));
        window.clearInterval(id);
      } else if (tries >= 14) {
        window.clearInterval(id);
      }
    }, 150);
    return () => window.clearInterval(id);
  }, [active, tourStep, location.pathname, featureSteps]);

  // Keep the spotlight glued to the live target after it first anchors. rc-tour
  // only re-measures the highlight on window resize or a target-element change —
  // never on scroll or async layout shifts. The sidebar header above the nav
  // grows as data loads (the org switcher and the "recent viewers" row, which
  // appears once >=2 viewers load), pushing every nav item down *after* antd has
  // measured, so the spotlight ends up one item too high. Watch for the target
  // actually moving and nudge a resize (rc-tour's only re-measure lever) so it
  // re-reads the settled rect. We compare top first, so resize only fires on a
  // real move — no spamming app-wide resize handlers when nothing shifted.
  useEffect(() => {
    if (!active) return;
    const step = featureSteps[tourStep];
    const sel = step?.selector ?? (step?.link ? `[data-tour-nav="${step.link}"]` : null);
    if (!sel) return;
    let raf = 0;
    let lastTop = Number.NaN;
    const check = () => {
      raf = 0;
      const el = document.querySelector(sel);
      if (!el) return;
      const top = Math.round(el.getBoundingClientRect().top);
      if (top !== lastTop) {
        lastTop = top;
        window.dispatchEvent(new Event('resize'));
      }
    };
    const schedule = () => {
      if (!raf) raf = window.requestAnimationFrame(check);
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(document.body);
    window.addEventListener('scroll', schedule, true);
    // Backstop the observers for the first stretch after the step opens, when the
    // late-loading header content settles.
    const poll = window.setInterval(schedule, 200);
    const stopPoll = window.setTimeout(() => window.clearInterval(poll), 1600);
    return () => {
      ro.disconnect();
      window.removeEventListener('scroll', schedule, true);
      window.clearInterval(poll);
      window.clearTimeout(stopPoll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [active, tourStep, location.pathname, featureSteps]);

  const markComplete = () => {
    if (classroom?.id && phaseRole) {
      fetcher.submit(JSON.stringify({ classroomId: classroom.id, role: phaseRole }), {
        method: 'POST',
        action: '/api/classroom-tour/complete',
        encType: 'application/json',
      });
    }
  };

  const finishPhase = () => {
    markComplete();
    if (tourPhase === 'instructor') {
      // Hand off to the student tour in the same sample course, at its first step.
      setTourStep(0);
      setTourPhase('student');
      if (classroom?.slug) navigate(`/student/${classroom.slug}`);
    } else {
      // The student tour ends the sequence.
      endTour();
      navigate('/select-organization');
    }
  };

  const skip = () => {
    endTour();
    navigate('/select-organization');
  };

  // Arrow keys drive the tour: Right = Next (Finish/Next on the last step),
  // Left = Previous. Ignored while focus is in a text field.
  const lastStep = featureSteps.length - 1;
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
        finishPhase();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, tourStep, lastStep, finishPhase, setTourStep]);

  if (!active) return null;

  const steps: TourProps['steps'] = featureSteps.map(s => ({
    title: s.title,
    description: s.description,
    target: s.selector ? selTarget(s.selector) : s.link ? navTarget(s.link) : undefined,
    placement: s.placement ?? (s.selector || s.link ? 'right' : undefined),
  }));

  return (
    <Tour
      open={active}
      current={tourStep}
      onChange={setTourStep}
      onClose={skip}
      onFinish={finishPhase}
      steps={steps}
      // The instructor tour continues into the student tour, so its last step
      // shows Skip/Next instead of the default "Finish". The student tour's last
      // step keeps the default "Finish" (it really does end the sequence).
      actionsRender={(origin, info) =>
        tourPhase === 'instructor' && info.current === info.total - 1 ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="small" onClick={skip}>
              Skip
            </Button>
            <Button size="small" type="primary" onClick={finishPhase}>
              Next
            </Button>
          </div>
        ) : (
          origin
        )
      }
      disabledInteraction
      // Instant so rc-tour's scroll-then-measure (in useTarget) reads the final
      // rect; a smooth scroll here mis-anchors the spotlight to the pre-scroll spot.
      scrollIntoViewOptions={{ block: 'center', behavior: 'instant' }}
      zIndex={2000}
    />
  );
}

export default InClassroomTour;
