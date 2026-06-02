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
    link: '/dashboard',
    selector: '[data-tour="dashboard-grading-tabs"]',
    placement: 'top',
    title: 'Grading tabs',
    description:
      'Switch between per-assignment grading progress and TA grading activity.',
  },
  {
    link: '/repos',
    title: 'Repositories',
    description:
      'Repositories are the units of coursework in your class, such as a lab, a project, or a weekly problem set. Each one is created from a GitHub template repository, and when you publish it Classmoji copies that repo to every student, or every team for group work.',
  },
  {
    link: '/repos',
    selector: '[data-tour="repos-new"]',
    placement: 'bottom',
    title: 'Create a repository',
    description:
      'Use New repository to add a unit of work from a template. The assignments inside become GitHub issues that Classmoji opens in each student’s copy of the repo, and you control release dates, due dates, and weighting per assignment.',
  },
  {
    link: '/repos/form',
    selector: '[data-tour="repos-form-title"]',
    placement: 'bottom',
    title: 'Name the repository',
    description: 'Type the repository title, which becomes the GitHub repo name in lowercase with dashes.',
  },
  {
    link: '/repos/form',
    selector: '[data-tour="repos-form-type"]',
    placement: 'bottom',
    title: 'Pick a type',
    description: 'Choose Individual or Group to control whether students work solo or in teams.',
  },
  {
    link: '/repos/form',
    selector: '[data-tour="repos-form-add-assignment"]',
    placement: 'left',
    title: 'Add assignments',
    description: 'Open the assignment editor to define each gradable assignment in this repository.',
  },
  {
    link: '/repos/form',
    selector: '[data-tour="repos-form-submit"]',
    placement: 'top',
    title: 'Create repository',
    description: 'Save everything to create the repository with its assignments and linked content.',
  },
  {
    link: '/repos',
    selector: '[data-tour="repos-cleanup"]',
    placement: 'bottom',
    title: 'Cleanup repos',
    description:
      'Finds students no longer on your roster so you can remove their leftover repos; nothing is deleted until you confirm.',
  },
  {
    link: '/repos',
    selector: '[data-tour="repos-link-resources"]',
    placement: 'bottom',
    title: 'Link resources',
    description: 'Attach pages, slides, or other resources to your repositories.',
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
    link: '/students/add',
    selector: '[data-tour="students-add-roster"]',
    placement: 'bottom',
    title: 'Paste your roster',
    description: 'Paste one student per line as name, email, so they can all be added at once.',
  },
  {
    link: '/students/add',
    selector: '[data-tour="students-add-parse"]',
    placement: 'top',
    title: 'Parse students',
    description: 'Validates your pasted text and previews who is ready to add and who was skipped.',
  },
  {
    link: '/students',
    selector: '[data-tour="students-search"]',
    placement: 'bottom',
    title: 'Search roster',
    description: 'Filter the roster by name, login, or email to find someone quickly.',
  },
  {
    link: '/teams',
    title: 'Teams for group work',
    description:
      'Teams let you run group projects instead of individual work. A group repository gives each team a single shared repo rather than one per student, and you can assign teams yourself or let students form their own, plus set a maximum team size.',
  },
  {
    link: '/teams',
    selector: '[data-tour="teams-new"]',
    placement: 'bottom',
    title: 'Create a team',
    description: 'Add a new team to this classroom; nothing is created until you submit.',
  },
  {
    link: '/teams/new',
    selector: '[data-tour="teams-new-name"]',
    placement: 'bottom',
    title: 'Team name',
    description: 'Type the name for the new team, which GitHub turns into the team slug.',
  },
  {
    link: '/teams/new',
    selector: '[data-tour="teams-new-visibility"]',
    placement: 'top',
    title: 'Team visibility',
    description: 'Choose whether the team is secret (members only) or visible to the whole organization.',
  },
  {
    link: '/teams/new',
    selector: '[data-tour="teams-new-submit"]',
    placement: 'top',
    title: 'Create team',
    description: 'Click to create the team in your GitHub organization and add it to the classroom.',
  },
  {
    link: '/assistants',
    title: 'Teaching assistants',
    description:
      'Assistants help you run and grade the class. You add a TA by GitHub username, then assign them specific submissions to grade from the repository view. This spreads grading across your staff so it scales even in a large course.',
  },
  {
    link: '/assistants',
    selector: '[data-tour="assistants-new"]',
    placement: 'bottom',
    title: 'Add assistant',
    description: 'Invite a new teaching assistant to this classroom.',
  },
  {
    link: '/grades',
    title: 'The gradebook',
    description:
      'The Grades page is a full gradebook with students as rows and assignments as columns. Grades are hidden from students by default and released per assignment when you are ready, and assignment grades roll up into repository grades and a final grade using the weighting you configure.',
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
    link: '/grades',
    selector: '[data-tour="grades-show-assignments"]',
    placement: 'bottom',
    title: 'Show assignments',
    description: 'Expand each repository into its individual assignment grade columns.',
  },
  {
    link: '/grades',
    selector: '[data-tour="grades-show-comments"]',
    placement: 'bottom',
    title: 'Show comments',
    description: 'Reveal the per-student comment column alongside grades.',
  },
  {
    link: '/grades',
    selector: '[data-tour="grades-search"]',
    placement: 'bottom',
    title: 'Search students',
    description: 'Filter the grades table to matching students by name, username, or email.',
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
    link: '/tokens/new',
    selector: '[data-tour="tokens-new-amount"]',
    placement: 'bottom',
    title: 'Token amount',
    description: 'Enter how many tokens each selected student will receive.',
  },
  {
    link: '/tokens/new',
    selector: '[data-tour="tokens-new-all-students"]',
    placement: 'bottom',
    title: 'All students',
    description: 'Check this to grant the tokens to every student in the class at once.',
  },
  {
    link: '/tokens/new',
    selector: '[data-tour="tokens-new-submit"]',
    placement: 'top',
    title: 'Assign tokens',
    description: 'Click to grant the tokens to the chosen students.',
  },
  {
    link: '/calendar',
    title: 'Course calendar',
    description:
      'The calendar holds your course schedule in one place: lectures, labs, office hours, and assessments. It gives you and your students a shared view of what is happening and when, alongside the deadlines coming from your repositories.',
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
    link: '/pages',
    selector: '[data-tour="pages-new"]',
    placement: 'bottom',
    title: 'New page',
    description: 'Create a new content page; nothing is published until you save.',
  },
  {
    link: '/pages/new',
    selector: '[data-tour="pages-new-title"]',
    placement: 'bottom',
    title: 'Page title',
    description: 'Type the page name; its slug and content path are generated from this title.',
  },
  {
    link: '/pages/new',
    selector: '[data-tour="pages-new-mode"]',
    placement: 'bottom',
    title: 'Creation mode',
    description: 'Start a blank page, import one markdown file, or batch import many.',
  },
  {
    link: '/pages/new',
    selector: '[data-tour="pages-new-submit"]',
    placement: 'top',
    title: 'Create page',
    description: 'Click to create the page in your content repo and save it to the course.',
  },
  {
    link: '/gitrepos',
    title: 'GitHub repos',
    description:
      'This page mirrors every student and team repository created from your published coursework, pulled from your GitHub organization, so you can jump to any repo and confirm copies were created. This example course uses mock data with no real GitHub org, so the list here is empty.',
  },
  {
    link: '/gitrepos',
    selector: '[data-tour="gitrepos-refresh"]',
    placement: 'bottom',
    title: 'Refresh repositories',
    description: 'Pull the latest repository list from your linked GitHub organization.',
  },
  {
    link: '/repo-health',
    title: 'Repo health',
    description:
      'Repo health surfaces patterns across student repositories, including commit timelines, contributor breakdowns, and flags for unusual activity, which helps you spot students who are stuck. Because this example course has no real repos, this view is empty here.',
  },
  {
    link: '/settings/general',
    selector: '[data-tour="settings-tab-general"]',
    placement: 'bottom',
    title: 'Settings, tab by tab',
    description:
      'Settings is split into tabs along the top, and we will click through the key ones. This first tab, General, holds the class name, its status, and the page students land on first.',
  },
  {
    link: '/settings/general',
    selector: '[data-tour="settings-save-profile"]',
    placement: 'bottom',
    title: 'Rename the class',
    description: 'Edit the class display name and click Save to apply it.',
  },
  {
    link: '/settings/general',
    selector: '[data-tour="settings-archive"]',
    placement: 'bottom',
    title: 'Archive the class',
    description:
      'When a term ends, archiving tucks the class out of the active classroom list so it stops cluttering everyone’s dashboard. Nothing is deleted, no one loses access, and you can unarchive it anytime.',
  },
  {
    link: '/settings/grades',
    selector: '[data-tour="settings-tab-grades"]',
    placement: 'bottom',
    title: 'Grades tab',
    description:
      'Define the emoji-to-number scale (what each emoji is worth) and the letter-grade ranges that turn those numbers into final grades.',
  },
  {
    link: '/settings/quizzes',
    selector: '[data-tour="settings-tab-quizzes"]',
    placement: 'bottom',
    title: 'Quizzes tab',
    description: 'Turn AI-graded quizzes on or off for the class and set their defaults.',
  },
  {
    link: '/settings/team',
    selector: '[data-tour="settings-tab-team"]',
    placement: 'bottom',
    title: 'Team tab',
    description:
      'Group-work rules live here: the maximum team size and whether students form their own teams or you assign them.',
  },
  {
    link: '/settings/extension',
    selector: '[data-tour="settings-tab-extension"]',
    placement: 'bottom',
    title: 'Extension tab',
    description:
      'Controls deadline-extension tokens: how many tokens a student spends to buy one extra hour past a due date.',
  },
  {
    link: '/settings/danger-zone',
    selector: '[data-tour="settings-tab-danger-zone"]',
    placement: 'bottom',
    title: 'Danger zone',
    description:
      'Irreversible actions like resetting all grades or deleting the class are isolated on this last tab so you never trigger them by accident.',
  },
  {
    title: 'Ask Moji',
    description:
      'Ask Moji is an in-class AI assistant that answers questions about your syllabus and course logistics. It is optional and you turn it on per class in settings, after which it appears in your sidebar to help you and your students with quick questions.',
  },
  {
    title: 'That’s the instructor side',
    description:
      'You have seen how an instructor sets up repositories, grades with emoji, manages the roster, and runs the class. Next we will reopen the same example course as a student so you can see exactly what your students see. Click Next to switch.',
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
      'This spotlight highlights your current repository and what is coming up next so you always know what to work on. It saves you from hunting through every repo to find the next thing due.',
  },
  {
    link: '/dashboard',
    selector: '[data-tour="dashboard-view-calendar"]',
    placement: 'bottom',
    title: 'View calendar',
    description: 'Jump to your full class calendar of upcoming events and deadlines.',
  },
  {
    link: '/dashboard',
    selector: '[data-tour="dashboard-activity-tabs"]',
    placement: 'top',
    title: 'Activity tabs',
    description: 'Switch between your recent feedback, team, and regrade activity.',
  },
  {
    link: '/repos',
    title: 'Your repositories',
    description:
      'Repositories are the units of coursework in the class, like labs, projects, and problem sets. Each one is your own GitHub repository, and the assignments inside it are GitHub issues you complete in that repo.',
  },
  {
    link: '/repos',
    selector: '[data-tour="repos-toggle"]',
    placement: 'bottom',
    title: 'Inside a repository',
    description:
      'Each repository is one of your coursework repos. Expand it to see its assignments and the resources your instructor attached, track how far along you are, then open the repo to start working.',
  },
  {
    link: '/assignments',
    title: 'Assignments',
    description:
      'This page lists all of your assignments across every repository in one place. Each assignment is a GitHub issue in your repo, with a due date and its current status, so you can see everything you owe without opening each repo separately.',
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
    link: '/assignments',
    selector: '[data-tour="assignments-tabs"]',
    placement: 'bottom',
    title: 'Filter assignments',
    description: 'Filter between current, completed, and all assignments.',
  },
  {
    link: '/tokens',
    title: 'Your tokens',
    description:
      'Tokens are how you give yourself extra time on a deadline without emailing your instructor. Your instructor grants you a balance, and once an assignment is past due you can spend tokens to extend it, paying a set number of tokens per hour.',
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
    link: '/calendar',
    selector: '[data-tour="calendar-view-toggle"]',
    placement: 'bottom',
    title: 'Week / month view',
    description: 'Switch the calendar between weekly and monthly views.',
  },
  {
    link: '/settings',
    title: 'Make it yours',
    description:
      'Settings let you personalize how Classmoji looks for you, including light or dark mode, an accent color, and a background. These are your own preferences and do not affect anyone else in the class.',
  },
  {
    link: '/settings',
    selector: '[data-tour="settings-theme"]',
    placement: 'bottom',
    title: 'Theme',
    description: 'Switch between light, dark, or system appearance.',
  },
  {
    link: '/settings',
    selector: '[data-tour="settings-accent"]',
    placement: 'bottom',
    title: 'Accent color',
    description: 'Pick the accent color used across buttons and highlights.',
  },
  {
    link: '/settings',
    selector: '[data-tour="settings-translucent-sidebar"]',
    placement: 'left',
    title: 'Translucent sidebar',
    description: 'Toggle a frosted, see-through sidebar look.',
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

  const steps: TourProps['steps'] = featureSteps.map(s => {
    const hasTarget = !!(s.selector || s.link);
    return {
      title: s.title,
      description: s.description,
      target: s.selector ? selTarget(s.selector) : s.link ? navTarget(s.link) : undefined,
      placement: s.placement ?? (hasTarget ? 'right' : undefined),
      // Informational steps with nothing to anchor get a darker full-screen mask
      // so they read as a deliberate "read this" moment instead of a tooltip whose
      // target failed to load. Anchored steps keep the default spotlight mask.
      mask: hasTarget ? undefined : { color: 'rgba(0, 0, 0, 0.8)' },
    };
  });

  return (
    <Tour
      rootClassName="cm-tour"
      open={active}
      current={tourStep}
      onChange={setTourStep}
      onClose={skip}
      onFinish={finishPhase}
      steps={steps}
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
