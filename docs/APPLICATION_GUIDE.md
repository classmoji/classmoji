# Classmoji - Complete Application Guide

## Table of Contents
- [Overview](#overview)
- [Architecture](#architecture)
- [User Roles & Permissions](#user-roles--permissions)
- [Core Features](#core-features)
  - [Assignment Management](#1-assignment-management)
  - [Emoji-Based Grading](#2-emoji-based-grading-system)
  - [Token System](#3-token-reward-system)
  - [Quiz System](#4-quiz-system)
  - [GitHub Integration](#5-github-integration)
  - [Team Management](#6-team-management)
  - [Subscription & Billing](#7-subscription--billing)
  - [Analytics](#8-analytics--tracking)
- [Technical Implementation](#technical-implementation)
- [Security & Compliance](#security--compliance)
- [Development & Deployment](#development--deployment)

---

## Overview

**Classmoji** is a comprehensive educational technology platform designed specifically for computer science courses that use GitHub for assignments. It automates classroom management, assignment distribution, grading workflows, and student engagement tracking through deep GitHub integration.

### Purpose
- Streamline CS course management with GitHub-native workflows
- Provide engaging, visual grading through emoji-based feedback
- Enable AI-powered assessments that understand student code
- Gamify learning through a token reward system
- Support collaborative learning with team management
- Offer comprehensive analytics for instructors

### Target Users
- **Computer Science Instructors**: Teaching courses with GitHub-based assignments
- **Teaching Assistants**: Grading and student support
- **Computer Science Students**: Taking courses using the platform

---

## Architecture

### Technology Stack

**Frontend**
- React 19 with React Router 7
- TailwindCSS for styling
- Remix-style route-based architecture

**Backend Services**
- **AI Agent** (`apps/ai-agent`): Unified WebSocket microservice for AI-powered features (quizzes, syllabus bot, prompt assistant)
- **Hook Station** (`apps/hook-station`): Webhook listener for GitHub and Stripe events
- **Web App** (`apps/webapp`): Main React application

**Data & Storage**
- PostgreSQL database with Prisma ORM
- Trigger.dev for background task processing
- Environment variables via `.env` file

**Integrations**
- GitHub OAuth & GitHub App
- Stripe for subscriptions
- OpenAI & Anthropic for AI quizzes
- Claude Agent SDK for code-aware quizzes

### Service Architecture

```
                    ┌─────────────────┐
                    │   GitHub API    │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  Hook Station   │◄──── GitHub Webhooks
                    │   (Webhooks)    │◄──── Stripe Webhooks
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  Trigger.dev    │
                    │ (Background)    │
                    └────────┬────────┘
                             │
┌─────────────┐                              ┌──────────────┐
│  React App  │◄────────────────────────────►│  PostgreSQL  │
│  (webapp)   │                              │  (Database)  │
└──────┬──────┘                              └──────────────┘
       │
       │ WebSocket
       ▼
┌─────────────┐     ┌─────────────────┐
│  AI Agent   │────►│  Claude Agent   │
│ (WebSocket) │     │      SDK        │
└─────────────┘     └─────────────────┘
```

### Monorepo Structure

```
classmoji/
├── apps/
│   ├── webapp/          # React Router 7 frontend
│   ├── ai-agent/        # WebSocket AI microservice (quiz, syllabus bot, prompt assistant)
│   ├── hook-station/    # Webhook listener
│   └── docs/            # Documentation
├── packages/
│   ├── database/        # Prisma schema & migrations
│   ├── llm/             # Centralized LLM functionality
│   ├── services/        # Shared business logic
│   ├── utils/           # Shared utilities
│   └── tasks/           # Trigger.dev workflows
└── package.json         # npm workspaces + Turborepo
```

---

## User Roles & Permissions

### Role Types

| Role | Description | Key Permissions |
|------|-------------|-----------------|
| **OWNER** | Instructor/Professor | Full administrative access, create assignments, manage settings, view all data |
| **TEACHER** | Co-instructor | Content and assessment: pages, slides, quizzes, the gradebook and grading — not classroom configuration |
| **ASSISTANT** | Teaching Assistant | Grade assignments, manage quizzes, view student data, manage regrade requests |
| **STUDENT** | Student | View own assignments, submit work, take quizzes, request extensions |

### Authorization System

The platform uses `assertClassroomAccess` helper for unified authorization:

```javascript
await assertClassroomAccess({
  request,
  classroomSlug,
  allowedRoles: ['OWNER'],              // Roles with blanket access
  resourceOwnerId: studentId,            // Resource owner's user ID
  selfAccessRoles: ['STUDENT'],          // Roles that can access their own
  resourceType: 'TOKEN_TRANSACTION',
  attemptedAction: 'cancel',
});
```

**Key Security Features:**
- Self-access patterns (students can view own resources)
- Resource ownership validation
- Audit logging for denied access attempts

### Permission Matrix Examples

| Resource | Student (Own) | Student (Others) | Assistant | Teacher | Owner |
|----------|--------------|------------------|-----------|---------|-------|
| View Assignment Grades | ✅ | ❌ | ✅ | ✅ | ✅ |
| View Gradebook / Student Report (letter override, staff note) | ❌ | ❌ | ❌ | ✅ | ✅ |
| View Roster Contact Details (email, school ID) | ❌ | ❌ | ❌ | ❌ | ✅ |
| Grant Tokens | ❌ | ❌ | ❌ | ❌ | ✅ |
| Grade Assignments (grading queue) | ❌ | ❌ | ✅ | ✅ | ✅ |
| Manage Quizzes | ❌ | ❌ | ✅ | ✅ | ✅ |
| Cancel Token Transaction | ✅ | ❌ | ❌ | ❌ | ✅ |
| Take Quiz | ✅ | ❌ | ❌ | ❌ | ❌* |
| View Quiz Attempts | ✅ | ❌ | ✅ | ✅ | ✅ |
| View Roster | ❌ | ❌ | ✅ | ✅ | ✅ |
| Manage Roster (add/remove students) | ❌ | ❌ | ❌ | ❌ | ✅ |
| Manage Settings | ❌ | ❌ | ❌ | ❌ | ✅ |

*Owners can take quizzes but typically don't

A student still sees their OWN grades — the per-assignment marks on their
assignments page, and via the `my_grades` MCP tool. The **gradebook** row above
is the staff-facing overview: every student's row at once, one column per
published assignment. The letter-grade override and the private staff note live
on the **student report** (`admin.$class.students_.$login`, re-exported for
teachers). Those two fields are what a student never sees, not their marks.

---

## Core Features

### 1. Assignment Management

#### Coursework Model

A **Module** is the unit of the curriculum: it lists content (pages, slide decks) and **Assignments**. Every assignment belongs to exactly one module (`module_id` is required) and has a `type`:

| Type | Backed by | Students submit by |
|------|-----------|--------------------|
| `REPO` | a **Repository** (`repository_id`): a template plus one git repo per student or team | pushing to their repo, or closing its GitHub issue (see submission modes) |
| `QUIZ` | a **Quiz** (`quiz_id`) | completing an attempt |
| `FORM` | a **Form** (`form_id`) | sending a response |

Repositories, quizzes and forms are the storage; assignments are what gets released, weighted and graded. A repository has no module and no weight of its own, and several assignments may submit through the same repository (a semester project graded at three milestones is one repository with three assignments).

**Individual vs group**: a repository creates one git repo per student or per team. Team repos get per-member contribution tracking.

#### Assignment Configuration

- **Weight** (`weight`): the only grading weight. Course grade = weighted mean of graded, non-extra-credit assignments, plus extra credit ([packages/utils/src/grades.ts](packages/utils/src/grades.ts)). Drop-lowest was removed.
- **Extra Credit** (`is_extra_credit`): bonus that does not enter the denominator
- **Deadlines**: `release_at` (when students see it), `student_deadline` (when work is due), `grader_deadline` (when grading should be done)
- **Tokens per hour** (`tokens_per_hour`): reward for early submission (Pro tier)
- **Submission mode** (`submission_mode`, `REPO` assignments only): `REPO` (push) or `ISSUE`. The database column defaults to `ISSUE`; the web UI and the MCP `assignment_create` tool default new assignments to `REPO`.

#### Submission Modes

A submission is a `GitRepoAssignment` row, unique per (`git_repo_id`, `assignment_id`). Its `closed_at` is the submission time and is frozen once the submission is graded.

- **`REPO` (push)**: the student's last push to the default branch before the deadline (plus any purchased extension hours) is the submission. `provider_id` / `provider_issue_number` stay null. When a submission row is created for a repo that already has commits, `ClassmojiService.gitRepoAssignment.recordExistingPush` stamps the latest student push (the template commit made within 2 minutes of repo creation and `[bot]` authors are excluded; the push must be before the deadline). `packages/database/scripts/backfillRepoSubmissions.ts` does the same for existing rows (`--apply`).
- **`ISSUE`**: a GitHub issue is opened in the student's repo. Closing it submits; reopening it un-submits.

#### Assignment Workflow

1. **Creation** ([admin.$class.modules/route.tsx](apps/webapp/app/routes/admin.$class.modules/route.tsx))
   - Instructor adds an assignment to a module, picks its type and the repository / quiz / form it submits through
   - Sets weight, deadlines and submission mode
   - Tests for autograding are edited on the repository form

2. **Publishing**
   - The assignment becomes visible to students at `release_at`
   - Publishing a repository triggers student repo creation

3. **Distribution** ([packages/tasks/src/workflows/](packages/tasks/src/workflows/))
   - Background task creates repositories from the template
   - Adds students as collaborators
   - Opens the GitHub issue for `ISSUE`-mode assignments; commits the autograding workflow when the repository has tests

4. **Submission** ([apps/hook-station/src/routes/github.ts](apps/hook-station/src/routes/github.ts))
   - `push` on a student repo (default branch only; bots and branch deletions ignored) → Trigger task `webhook-git_repo_push_handler` → `gitRepoAssignment.recordPush`
   - `issues.closed` records the submission time; `issues.reopened` clears it
   - Late hours are calculated from `closed_at` against the deadline

5. **Grading** ([admin.$class.assignments_.$id/route.tsx](apps/webapp/app/routes/admin.$class.assignments_.$id/route.tsx))
   - One roster per assignment: graders are assigned and grades entered on the assignment page (re-exported for teachers and assistants; grader changes are owner/teacher only)
   - The gradebook ([admin.$class.grades/route.tsx](apps/webapp/app/routes/admin.$class.grades/route.tsx)) is the overview: one column per published assignment, grouped by type in deadline order, Total and Letter pinned right, grading in the cell
   - Grades are released when ready

#### GitHub Integration Features

- **Repository Templates**: student repos are cloned from a template repo
- **Push or Issue Submission**: chosen per assignment
- **Autograding**: tests on the repository run as a GitHub Actions workflow committed to every student repo; results are advisory (`autograding_results`), never grades
- **Contribution Analysis**: Track individual commits in group projects

#### File Locations

- Modules: [apps/webapp/app/routes/admin.$class.modules/](apps/webapp/app/routes/admin.$class.modules/), module card: [apps/webapp/app/components/features/modules/ModuleCard.tsx](apps/webapp/app/components/features/modules/ModuleCard.tsx)
- Assignment page: [apps/webapp/app/routes/admin.$class.assignments_.$id/](apps/webapp/app/routes/admin.$class.assignments_.$id/)
- Repositories list: [apps/webapp/app/routes/admin.$class.repos/](apps/webapp/app/routes/admin.$class.repos/), table: [apps/webapp/app/components/features/repositories/RepositoriesTable.tsx](apps/webapp/app/components/features/repositories/RepositoriesTable.tsx)
- Student assignments: [apps/webapp/app/routes/student.$class.assignments/](apps/webapp/app/routes/student.$class.assignments/)
- Repository tasks: [packages/tasks/src/workflows/](packages/tasks/src/workflows/)

---

### 2. Emoji-Based Grading System

#### Overview

The platform's unique grading approach uses **emojis mapped to numeric grades**, making feedback more visual and engaging than traditional numeric systems.

#### How It Works

A classroom grades on one of two scales. Either way every grade is stored as a number.

**Emoji scale** ([admin.$class.settings.grades](apps/webapp/app/routes/admin.$class.settings.grades/)): each emoji maps to a number in Settings → Grades. A submission's grade is the mean of its emojis, and graders may stack several.
```
🎯 = 100 (Perfect)
⭐ = 95  (Excellent)
🚀 = 90  (Great)
👍 = 85  (Good)
💪 = 80  (Solid)
...and more
```

**Numeric scale**: the built-in `score-0` … `score-100` emojis ([packages/utils/src/emojis.ts](packages/utils/src/emojis.ts): `SCORE_EMOJI_PREFIX`, `isScoreScheme`, `parseScoreEmoji`). On a numeric scale the Grade cell is an inline number field (`EmojiGrader.tsx`) and each grader holds **one score per submission**: entering a new score replaces that grader's previous one (its token reward reversed); other graders' scores stay. `GradeBadges` hides the viewer's own score next to the field. Migration `20260920000003_one_score_per_grader` collapsed old stacked scores.

`HelperService.addGradeToGitRepoAssignment` ([packages/services/src/helper/index.ts](packages/services/src/helper/index.ts)) refuses any grade that is not in the classroom scale, on either scale.

**Configurable Per Classroom**
- Instructors can customize emoji-grade mappings
- Set letter grade thresholds (A+, A, B+, etc.)
- Configure late penalty points per hour

#### Grading Workflow

1. **Grader Assignment**
   - Instructors assign TAs/themselves per assignment (assignment page → Assign graders)
   - Each submission can have multiple graders

2. **Grade Entry**
   - Emoji scale: grader picks one or more emojis per submission
   - Numeric scale: grader types a number; one score per grader
   - Grading happens on the assignment page or in the gradebook cell

3. **Grade Calculation** ([packages/utils/src/grades.ts](packages/utils/src/grades.ts))
   ```
   Submission grade = mean of its grades (minus late penalty)
   Course grade     = weighted mean of graded non-extra-credit assignments + extra credit
   ```

4. **Grade Release**
   - Instructors control when grades become visible to students
   - Toggle show/hide grades globally

#### Features

- **Multiple Graders**: Average scores from multiple graders (numeric scale: one score per grader)
- **Late Penalties**: Automatic deduction based on late hours
- **Extra Credit**: Bonus points that don't affect grade denominator
- **Weighted Grades**: Each assignment's `weight` is the only weight in the course grade; no drop-lowest
- **Letter Conversion**: Automatic conversion to letter grades
- **Token Integration**: Earn tokens for high grades (Pro tier)

#### File Locations

- Assignment grading page: [apps/webapp/app/routes/admin.$class.assignments_.$id/](apps/webapp/app/routes/admin.$class.assignments_.$id/)
- Gradebook: [apps/webapp/app/routes/admin.$class.grades/](apps/webapp/app/routes/admin.$class.grades/)
- Student report (letter override, staff note): [apps/webapp/app/routes/admin.$class.students_.$login/](apps/webapp/app/routes/admin.$class.students_.$login/)
- Grade settings: [apps/webapp/app/routes/admin.$class.settings.grades/](apps/webapp/app/routes/admin.$class.settings.grades/)
- Grade engine: [packages/utils/src/grades.ts](packages/utils/src/grades.ts), scale helpers: [packages/utils/src/emojis.ts](packages/utils/src/emojis.ts)

---

### 3. Token Reward System

**Pro Tier Feature** - Gamification system that rewards timely work and allows students to "purchase" extensions.

#### Token Economics

**Earning Tokens**
- **Time-Based**: Configurable tokens per hour before deadline
- **Early Submission**: Automatic token awards for timely work
- **Bulk Grants**: Instructors can manually award tokens

**Spending Tokens**
- **Deadline Extensions**: Students spend tokens to extend deadlines
- Configurable exchange rate (e.g., 10 tokens = 1 hour extension)

#### Transaction Types

| Type | Description | Balance Impact |
|------|-------------|----------------|
| `GAIN` | Earned through timely submission | + |
| `SPENDING` | Used for extension purchase | - |
| `REMOVAL` | Manual deduction by instructor | - |
| `REFUND` | Cancelled transaction reversal | + |

#### Token Workflow

1. **Configuration** ([token-settings.jsx](apps/webapp/app/routes/admin.$org.settings.tokens/token-settings.jsx))
   - Set default tokens per hour
   - Configure exchange rates
   - Enable/disable token system

2. **Automatic Awards** ([calculate tokens](packages/services/src/token.service.js))
   ```javascript
   tokens_earned = hours_before_deadline * tokens_per_hour
   ```

3. **Extension Requests** ([extension-request.jsx](apps/webapp/app/routes/student.$org.assignments.$assignmentSlug.extension-request/extension-request.jsx))
   - Student requests X hours extension
   - Cost calculated: `hours * rate`
   - Tokens deducted upon approval

4. **Transaction History** ([tokens.jsx](apps/webapp/app/routes/student.$org.tokens/tokens.jsx))
   - Students view complete transaction history
   - See current balance and spending patterns

#### Admin Features

- **Bulk Token Assignment**: Award tokens to multiple students
- **Token Statistics**: View earning/spending trends
- **Transaction Management**: Cancel and refund transactions
- **Balance Tracking**: Per-student token balances

#### File Locations

- Token service: [packages/services/src/token.service.js](packages/services/src/token.service.js)
- Student token view: [apps/webapp/app/routes/student.$org.tokens/](apps/webapp/app/routes/student.$org.tokens/)
- Token settings: [apps/webapp/app/routes/admin.$org.settings.tokens/](apps/webapp/app/routes/admin.$org.settings.tokens/)
- Token workflows: [packages/tasks/src/workflows/token-workflows.js](packages/tasks/src/workflows/token-workflows.js)

---

### 4. Quiz System

The platform offers two distinct quiz modes, both centralized in `@classflow/llm` package.

#### A. Standard Quiz Mode (LangChain-based)

**Overview**
- Conversational AI-powered assessments
- Uses OpenAI GPT-4 or Anthropic Claude via LangChain
- Traditional chat-based quiz format

**Configuration** ([quiz-settings.jsx](apps/webapp/app/routes/admin.$org.settings.quizzes/quiz-settings.jsx))
- Choose LLM provider (OpenAI/Anthropic)
- Select model (gpt-4, claude-3-opus, etc.)
- Configure temperature (0.0-1.0)
- Set max tokens
- Use org API key or system defaults

**Features**
- Custom system prompts and rubrics
- Configurable question count
- Difficulty levels and subject tags
- Due date enforcement
- Auto-grading with structured evaluation

**Flow**
```
Student starts quiz
  ↓
webapp/action.server.js
  ↓
@classflow/llm (StandardQuizService)
  ↓
LangChain API (OpenAI/Anthropic)
  ↓
Response displayed in chat interface
```

#### B. Code-Aware Quiz Mode (Agent SDK-based)

**Revolutionary Feature**: AI explores student's actual GitHub repository before asking questions.

**How It Works**
1. **Repository Cloning**
   - Student's GitHub repo cloned to secure sandbox
   - Path validation and security constraints applied

2. **Code Exploration** ([agent-sdk provider](apps/ai-agent/src/llm/providers/agent-sdk/))
   - Claude Agent SDK with file access tools:
     - `Read`: Read file contents
     - `Grep`: Search code for patterns
     - `Glob`: Find files by pattern
     - `Bash`: Execute commands (limited)

3. **Real-Time Streaming**
   - Exploration steps streamed to student via WebSocket
   - Student sees what AI is examining
   - "Looking at your code..." messages

4. **Evidence-Based Questions**
   - Questions based on actual code implementation
   - References specific files and line numbers
   - Context-aware follow-ups

**Example Exploration**
```
🔍 Exploring your repository...
📂 Found src/components/Button.tsx
📖 Reading implementation...
🔎 Searching for event handlers...

Question: I notice you're using inline arrow functions in your
Button component at line 42. Can you explain the performance
implications of this approach?
```

**Security Features**
- Sandboxed execution environment
- Path validation (can't access system files)
- Limited command execution
- No network access from sandbox
- Automatic cleanup after quiz

**Flow**
```
Student starts code-aware quiz
  ↓
webapp/action.server.js
  ↓
WebSocket connection to ai-agent
  ↓
@classflow/llm (CodeAwareQuizService)
  ↓
Claude Agent SDK + cloned repository
  ↓
Real-time exploration steps → WebSocket → Student UI
```

#### Quiz Features (Both Modes)

**Quiz Configuration**
- Title, description, and instructions
- Assignment linkage (quiz grade → assignment grade)
- Due date enforcement
- Draft/Published/Archived status
- Rich text editor for content
- Difficulty level and tags

**Quiz Attempts**
- One attempt per student (configurable)
- Focus time tracking (total time vs unfocused time)
- Question counting and limits
- Auto-save progress (draft mode)
- Evaluation feedback display
- Replay/review functionality

**Grading**
- Auto-grading with AI evaluation
- Structured rubric scoring
- Detailed feedback per question
- Integration with assignment grades
- Manual grade override option

#### File Locations

- LLM code: [apps/ai-agent/src/llm/](apps/ai-agent/src/llm/) (private submodule; `packages/llm` no longer exists)
  - Agent SDK provider: [apps/ai-agent/src/llm/providers/agent-sdk/](apps/ai-agent/src/llm/providers/agent-sdk/)
  - Quiz evaluation schema: [apps/ai-agent/src/llm/schemas/quizEvaluation.js](apps/ai-agent/src/llm/schemas/quizEvaluation.js)
- AI agent service: [apps/ai-agent/](apps/ai-agent/)
- Quiz routes: [apps/webapp/app/routes/student.$org.quizzes/](apps/webapp/app/routes/student.$org.quizzes/)
- Quiz settings: [apps/webapp/app/routes/admin.$org.settings.quizzes/](apps/webapp/app/routes/admin.$org.settings.quizzes/)

---

### 5. GitHub Integration

Deep integration with GitHub is a core feature, automating classroom workflows.

#### GitHub App Installation

**Setup Process**
1. Install Classmoji GitHub App on organization
2. Grant repository access permissions
3. Webhook events automatically configured
4. Background task completes setup

**Required Permissions** ([setup/manifest.ts](apps/webapp/app/routes/setup/manifest.ts))
- Contents: Read & Write (create student repos from templates)
- Issues: Read & Write
- Workflows: Read & Write (the App commits `.github/workflows/classroom.yml` to student repos for autograding)
- Members: Read
- Metadata: Read
- Webhook events: `push`, `issues`, `organization` (see Webhook Events below)

#### OAuth Authentication

**User Flow**
1. User clicks "Sign in with GitHub"
2. OAuth flow grants access token
3. Token stored securely (encrypted)
4. User profile synced (username, email, avatar)

#### Repository Management

**Automatic Repository Creation** ([create-repos.js](packages/tasks/src/workflows/create-repos.js))
```javascript
For each student in course:
  1. Clone template repository
  2. Create student repository (name: assignment-username)
  3. Add student as collaborator (write access)
  4. Add graders as collaborators (read access)
  5. Create GitHub issue linked to assignment
  6. Track progress in Trigger.dev dashboard
```

**Repository Features**
- Template-based creation
- Naming conventions: `{assignment-slug}-{username}`
- Automatic collaborator management
- Workflow file inclusion (for GitHub Actions)
- Repository deletion on assignment removal

#### Submission Tracking

**Push Workflow** (`submission_mode = REPO`, the default for new assignments)
1. **Creation**: a `GitRepoAssignment` row per (student repo, assignment); no issue is opened
2. **Submission**: the student pushes to the repo's default branch
3. **Webhook**: `push` → `webhook-git_repo_push_handler` → `gitRepoAssignment.recordPush` stamps `closed_at` with the delivery time (pushes after the deadline + purchased extension hours do not move it; frozen once graded)
4. **Existing commits**: `recordExistingPush` stamps the latest student push when the row is created for a repo that already has commits
5. **Grading**: graders open the repo from the assignment page

**Issue Workflow** (`submission_mode = ISSUE`)
1. **Creation**: GitHub issue created in the student repo per assignment
2. **Assignment**: Issue assigned to student
3. **Submission**: Student closes issue when complete
4. **Webhook**: `issues.closed` records the submission; `issues.reopened` un-submits
5. **Grading**: Graders access issue directly from platform

**Issue Features**
- Links back to platform dashboard
- Contains assignment instructions
- Due date in description
- Tracks open/closed status

#### Webhook Events

**GitHub Webhooks** ([apps/hook-station/src/routes/github.ts](apps/hook-station/src/routes/github.ts))

| Event | Action | Purpose |
|-------|--------|---------|
| `push` (student repo) | Trigger `webhook-git_repo_push_handler` | Record the push as the submission for every published `REPO`-mode assignment on that repo (default branch only; bots and branch deletions ignored) |
| `push` (classroom content repo) | Sync content assets | Refresh the classroom's path → SHA map |
| `issues.closed` | Record submission timestamp | Track when student completes work (`ISSUE` mode) |
| `issues.reopened` | Clear submission timestamp | Un-submit |
| `issues.deleted` | Mark issue as deleted | Handle issue removal |
| `organization.member_added` | Sync roster | Auto-add new org members |
| `installation.created` | Setup organization | Complete GitHub App installation |
| `installation.deleted` | Cleanup | Remove organization data |
| `installation.suspend` / `unsuspend` | Pause / resume | Stop minting tokens while suspended |

The GitHub App must subscribe to `push`, `issues` and `organization` (`default_events` in [setup/manifest.ts](apps/webapp/app/routes/setup/manifest.ts)). An App created before push mode existed needs `push` added by hand in its GitHub settings.

**Webhook Processing**
```
GitHub event
  ↓
Hook Station receives POST
  ↓
Validate signature (security)
  ↓
Trigger background task if needed
  ↓
Update database
  ↓
Return 200 OK (fast response)
```

#### Group Work Features

**Contribution Tracking** ([calculate-contributions.js](packages/tasks/src/workflows/calculate-contributions.js))
- Analyze Git commit history
- Count commits per team member
- Calculate contribution percentages
- Display in admin dashboard
- Inform grade adjustments

#### File Locations

- GitHub service: [packages/services/src/github.service.js](packages/services/src/github.service.js)
- Webhook handlers: [apps/hook-station/src/routes/github.ts](apps/hook-station/src/routes/github.ts)
- Repository workflows: [packages/tasks/src/workflows/repo-workflows.js](packages/tasks/src/workflows/repo-workflows.js)
- GitHub auth: [apps/webapp/app/routes/auth.github/](apps/webapp/app/routes/auth.github/)

---

### 6. Team Management

**Pro Tier Feature** - Support for group projects and collaborative learning.

#### Team Configuration

**Team Creation** ([teams.jsx](apps/webapp/app/routes/admin.$org.teams/teams.jsx))
- Set team name
- Assign team members (students)
- Add team tags (section, cohort, project group)
- Configure visibility settings

**Team Features**
- Shared repository for group assignments
- Individual contribution tracking
- Team-based grading with individual adjustments
- Team avatar groups in UI
- Tag-based organization

#### Group Assignment Workflow

1. **Setup**
   - Instructor creates group assignment
   - Teams assigned to assignment
   - Shared repository created per team

2. **Collaboration**
   - All team members have write access to shared repo
   - Commits tracked per member
   - Issues shared among team

3. **Submission**
   - Team submits as unit (one issue closed by any member)
   - Submission timestamp recorded

4. **Grading**
   - Base grade assigned to entire team
   - Instructors can adjust individual grades based on contributions
   - Contribution percentages inform adjustments

#### Contribution Analysis

**Automatic Calculation** ([calculate-contributions.js](packages/tasks/src/workflows/calculate-contributions.js))
```javascript
For each team member:
  commits = count commits by author
  percentage = (member_commits / total_commits) * 100
  display in dashboard
```

**Contribution Display**
- Visual progress bars
- Commit counts per member
- Percentage contribution
- Timeline of contributions

#### File Locations

- Team management: [apps/webapp/app/routes/admin.$org.teams/](apps/webapp/app/routes/admin.$org.teams/)
- Team settings: [apps/webapp/app/routes/admin.$org.settings.teams/](apps/webapp/app/routes/admin.$org.settings.teams/)
- Contribution workflows: [packages/tasks/src/workflows/calculate-contributions.js](packages/tasks/src/workflows/calculate-contributions.js)

---

### 7. Subscription & Billing

Integration with Stripe for subscription management.

#### Subscription Tiers

| Feature | FREE | PRO |
|---------|------|-----|
| Basic assignments | ✅ | ✅ |
| Emoji grading | ✅ | ✅ |
| Standard quizzes | ✅ | ✅ |
| Token system | ❌ | ✅ |
| Team management | ❌ | ✅ |
| Code-aware quizzes | ❌ | ✅ |
| Advanced analytics | ❌ | ✅ |
| Priority support | ❌ | ✅ |

#### Subscription Workflow

**Upgrade to Pro** ([billing.jsx](apps/webapp/app/routes/admin.$org.billing/billing.jsx))
1. Instructor clicks "Upgrade to Pro"
2. Redirected to Stripe Checkout
3. Payment processed
4. Webhook confirms subscription
5. Organization tier updated
6. Pro features unlocked

**Subscription Management**
- View current plan and status
- Access customer portal for:
  - Update payment method
  - Download invoices
  - Cancel subscription
- Cancellation feedback collected

#### Stripe Integration

**Checkout Session** ([stripe.service.js](packages/services/src/stripe.service.js))
```javascript
Create checkout session:
  - Org metadata attached
  - Success URL: return to dashboard
  - Cancel URL: return to billing page
  - Subscription mode (not one-time)
```

**Webhook Events** ([stripe handlers](apps/hook-station/src/webhooks/stripe/handlers.js))

| Event | Action | Effect |
|-------|--------|--------|
| `customer.subscription.created` | Create subscription record | Enable Pro features |
| `customer.subscription.updated` | Update status | Handle cancellation |
| `customer.subscription.deleted` | Mark expired | Disable Pro features |
| `invoice.payment_failed` | Notify admin | Alert payment issue |

**Subscription Status**
- `Active`: Currently subscribed, Pro features enabled
- `Canceled`: Will expire at period end, features still active
- `Expired`: Past end date, Pro features disabled
- `Inactive`: Not subscribed, FREE tier

#### File Locations

- Billing routes: [apps/webapp/app/routes/admin.$org.billing/](apps/webapp/app/routes/admin.$org.billing/)
- Stripe service: [packages/services/src/stripe.service.js](packages/services/src/stripe.service.js)
- Stripe webhooks: [apps/hook-station/src/webhooks/stripe/](apps/hook-station/src/webhooks/stripe/)

---

### 8. Audit Logging

User actions are tracked via the built-in audit logging system (`addAuditLog` / `ClassmojiService.audit`) covering 45+ resource types across 120+ locations. This provides comprehensive tracking of all important data mutations for security, debugging, and compliance purposes without requiring any third-party SaaS dependency.

---

## Additional Features

### Regrade Request System

**Student Workflow** ([regrade-request.jsx](apps/webapp/app/routes/student.$org.grades.regrade-request/regrade-request.jsx))
1. Student views grade they believe is incorrect
2. Submits regrade request with explanation
3. Request appears in instructor dashboard
4. Instructor/TA reviews with context
5. Grade adjusted or explanation provided
6. Student notified of resolution

**Features**
- Request status tracking (In Review / Resolved)
- Previous grade history
- Grader comments for resolution notes
- Organization-wide view for instructors

### Extension Management

**Extension Workflow** ([extensions.jsx](apps/webapp/app/routes/admin.$org.extensions/extensions.jsx))
1. Student requests deadline extension
2. Optionally spends tokens (Pro tier)
3. Provides reason/justification
4. Request appears in admin dashboard
5. Instructor approves/denies
6. Deadline automatically adjusted
7. Late penalty waived if approved

**Admin Features**
- Bulk extension approval
- Late override (waive penalty without extension)
- Extension history per student
- Token cost display

### Student Dashboard

**Dashboard Features** ([dashboard.jsx](apps/webapp/app/routes/student.$org/dashboard.jsx))
- Assignment list with status (open/closed)
- Countdown timers to deadlines
- Grade display (when released)
- Token balance (Pro tier)
- Upcoming quizzes
- Recent submissions
- Late submission warnings

**Assignment Cards**
- Visual status indicators
- Time remaining display
- Grade reveal on hover (when available)
- Direct link to GitHub repo
- Extension request button

### Instructor Dashboard

**Admin Dashboard** ([admin.tsx](apps/webapp/app/routes/admin.$org/admin.tsx))

**Key Metrics**
- Total student count
- Active assignments
- Submission progress (X of Y submitted)
- Late submission percentage
- Grading progress
- Ungraded assignments count

**Visualizations**
- Submission timeline chart
- Leaderboard (top/bottom performers)
- Grading progress per issue
- TA grading leaderboard
- Token distribution (Pro tier)

**Quick Actions**
- Create assignment
- Grant tokens
- View extensions
- Manage teams
- Access settings

### Student Roster Management

**Roster Features** ([roster.jsx](apps/webapp/app/routes/admin.$org.roster/roster.jsx))
- CSV import for bulk student addition
- GitHub organization sync
- Student profile management
- Student ID assignment
- Email management
- Individual grade comments
- Token balance per student
- Invitation tracking

**Bulk Operations**
- Add multiple students via CSV
- Grant tokens to all/selected students
- Send email to all/selected students
- Export roster to CSV

### Organization Settings

**Settings Categories** ([settings routes](apps/webapp/app/routes/admin.$org.settings/))

1. **General** ([general-settings.jsx](apps/webapp/app/routes/admin.$org.settings.general/general-settings.jsx))
   - Organization name, term, year
   - Emoji selection for branding
   - Syllabus content (rich text editor)

2. **Grading** ([grade-settings.jsx](apps/webapp/app/routes/admin.$org.settings.grades/grade-settings.jsx))
   - Emoji to grade mappings
   - Letter grade thresholds
   - Late penalty points per hour
   - Show/hide grades toggle

3. **Tokens** ([token-settings.jsx](apps/webapp/app/routes/admin.$org.settings.tokens/token-settings.jsx))
   - Default tokens per hour
   - Extension exchange rate
   - Token transaction rules

4. **Quizzes** ([quiz-settings.jsx](apps/webapp/app/routes/admin.$org.settings.quizzes/quiz-settings.jsx))
   - Enable/disable quizzes
   - LLM provider (OpenAI/Anthropic)
   - Model selection
   - Temperature and max tokens
   - Organization API keys
   - Code-aware quiz configuration

5. **Teams** ([team-settings.jsx](apps/webapp/app/routes/admin.$org.settings.teams/team-settings.jsx))
   - Team management preferences
   - Default team size
   - Tag configuration

---

## Technical Implementation

### Database Schema

**Core Entities** ([schema.prisma](packages/database/prisma/schema.prisma))

```prisma
User
  ├── id (GitHub ID)
  ├── username, email, name
  ├── avatar_url
  └── Memberships (roles in orgs)

Organization
  ├── id (GitHub org ID)
  ├── login (slug/identifier)
  ├── settings (JSON)
  └── Subscription

Membership
  ├── user_id
  ├── organization_id
  ├── role (OWNER/ASSISTANT/STUDENT)
  └── accepted (invitation status)

Module
  ├── classroom_id
  ├── title, position
  ├── Items (pages, slides)
  └── Assignments

Assignment
  ├── module_id (required)
  ├── type (REPO/QUIZ/FORM)
  ├── repository_id / quiz_id / form_id (exactly one)
  ├── title, description
  ├── weight (the only grading weight), is_extra_credit
  ├── release_at, student_deadline, grader_deadline
  ├── tokens_per_hour
  ├── submission_mode (ISSUE/REPO; column default ISSUE, UI/MCP default REPO)
  └── GitRepoAssignments (submissions)

Repository
  ├── classroom_id
  ├── title, template
  ├── AutogradingTests
  ├── GitRepos (one per student/team)
  └── (no module, no weight — attached through Assignments)

GitRepo
  ├── provider_id (GitHub repo id)
  ├── repository_id
  ├── student_id / team_id
  └── contributions (JSON)

GitRepoAssignment (the submission; unique per git_repo_id + assignment_id)
  ├── git_repo_id
  ├── assignment_id
  ├── provider_id, provider_issue_number (null in REPO mode)
  ├── closed_at (submission time; frozen once graded)
  ├── late_hours
  └── Grades (emoji / score-N grades)

Team
  ├── name
  ├── organization_id
  └── Members (students)

Quiz
  ├── title, description
  ├── assignment_id (optional)
  ├── due_date
  ├── mode (STANDARD/CODE_AWARE)
  ├── llm_config (JSON)
  └── Attempts

QuizAttempt
  ├── quiz_id
  ├── user_id
  ├── total_focus_time_seconds
  ├── total_unfocused_time_seconds
  ├── question_count
  └── evaluation (JSON)

TokenTransaction
  ├── student_id
  ├── amount
  ├── type (GAIN/SPENDING/REMOVAL/REFUND)
  ├── balance_after
  └── metadata (JSON)

Subscription
  ├── organization_id
  ├── stripe_subscription_id
  ├── status (ACTIVE/CANCELED/EXPIRED)
  ├── current_period_start/end
  └── tier (FREE/PRO)

AuditLog
  ├── user_id
  ├── organization_id
  ├── action (ACCESS_DENIED/GRADE_RELEASED/…)
  ├── resource_type, resource_id
  └── metadata (JSON)
```

**Key Schema Features**
- BigInt IDs for GitHub compatibility
- JSON fields for flexible configuration
- Cascade deletes for data integrity
- Indexes for query performance
- Timestamps on all entities

### Background Task Processing

**Trigger.dev Workflows** ([packages/tasks/src/workflows/](packages/tasks/src/workflows/))

**Repository Workflows**
- `createRepositories`: Bulk repository creation from templates
- `deleteRepository`: Clean up when a repository is removed
- `updateRepositoryCollaborators`: Sync collaborator permissions
- `dispatch_autograde_workflow`: commit `.github/workflows/classroom.yml` to every student repo (`provisionAutogradeWorkflowForRepo` does it for new repos); `ingest_autograde_result` receives the results

**Submission Workflows** ([gitRepoAssignment.ts](packages/tasks/src/workflows/gitRepoAssignment.ts))
- `webhook-git_repo_push_handler`: a push on a student repo → `ClassmojiService.gitRepoAssignment.recordPush` stamps `closed_at` on every published `REPO`-mode submission for that repo (before the deadline + extensions; frozen once graded)
- `recordExistingPush` (service, not a task): when a `REPO`-mode submission row is created for a repo that already has commits, stamps the student's latest push (template commit within 2 minutes of repo creation and `[bot]` authors excluded)
- `packages/database/scripts/backfillRepoSubmissions.ts --apply`: the same for rows that predate push mode
- `issues.closed` / `issues.reopened` / `issues.deleted` handlers: `ISSUE`-mode submission, un-submission and cleanup

**Coursework migrations** (`packages/database/migrations/20260920*`)
- `20260920000000_coursework_phase1_additive`: modules at root, typed assignments (`type`, `module_id`, `repository_id`/`quiz_id`/`form_id`)
- `20260920000001_coursework_phase1_constraints`: required `module_id`, one backing resource per assignment, single `weight`
- `20260920000002_submission_modes`: `Assignment.submission_mode`, nullable issue columns on `GitRepoAssignment`
- `20260920000003_one_score_per_grader`: collapsed stacked `score-N` grades to one per grader

**Organization Workflows**
- `setupOrganization`: Complete GitHub App installation
- `syncRoster`: Import members from GitHub org

**Token Workflows**
- `bulkAssignTokens`: Grant tokens to multiple students
- `processExtension`: Deduct tokens and extend deadline

**Email Workflows**
- `send_email`: The single transactional-email task. Takes `{ to, subject, html }`
  and sends through Resend. Callers compose the HTML themselves (see
  `notificationEmails.ts` and `roster.service.ts`) and enqueue this task; services
  never send directly. Requires `RESEND_API_KEY`, with `EMAIL_FROM` and
  `EMAIL_REPLY_TO` as optional overrides.

**Task Features**
- Real-time progress tracking in UI
- Concurrency limits (rate limiting)
- Automatic retries on failure
- Webhook trigger support
- Cron schedule support

**Secret Management**
- Trigger.dev deployments automatically sync environment variables from Infisical
- Configured via `syncEnvVars` extension in `trigger.config.js`
- Currently uses `prod` environment for all deployments
- Local development uses `.env` file (no Infisical needed)
- To update secrets: modify in Infisical dashboard → redeploy workflows

### LLM Architecture

LLM code lives in the private `ai-agent` submodule at [apps/ai-agent/src/llm/](apps/ai-agent/src/llm/) (`QuizService`, Agent SDK provider, quiz evaluation schema); `packages/llm` no longer exists. The webapp never calls a model directly: it talks to the AI agent over WebSocket, and the public-facing exports (`getAllModels`, `examplePrompts`) come from `@classmoji/services`.

### WebSocket Architecture

**AI Agent Service** ([apps/ai-agent/](apps/ai-agent/))

```javascript
// WebSocket server for real-time quiz communication
const wss = new WebSocketServer({ port: 8080 });

wss.on('connection', (ws) => {
  ws.on('message', async (message) => {
    const { type, payload } = JSON.parse(message);

    switch (type) {
      case 'START_QUIZ':
        // Initialize quiz session
        // Clone repository if code-aware
        // Start Agent SDK exploration
        break;

      case 'SEND_MESSAGE':
        // Student response
        // Process with LLM
        // Stream exploration steps
        break;

      case 'END_QUIZ':
        // Finalize and grade
        // Cleanup sandbox
        break;
    }
  });
});
```

**WebSocket Message Types**
- `START_QUIZ`: Initialize quiz session
- `SEND_MESSAGE`: Student sends answer
- `RECEIVE_MESSAGE`: AI sends question
- `EXPLORATION_STEP`: Code exploration update
- `END_QUIZ`: Complete quiz session
- `ERROR`: Error occurred

### Authentication & Authorization

**JWT-Based Authentication** ([auth.service.js](packages/services/src/auth.service.js))

```javascript
// GitHub OAuth flow
1. User clicks "Sign in with GitHub"
2. Redirect to GitHub OAuth
3. GitHub redirects back with code
4. Exchange code for access token
5. Fetch user profile from GitHub
6. Generate JWT with user ID
7. Set secure HTTP-only cookie
8. Redirect to dashboard
```

**Token Structure**
```javascript
{
  userId: 12345,
  exp: 1234567890, // Expiration timestamp
  iat: 1234567890  // Issued at timestamp
}
```

**Authorization Helper** ([helpers.js:assertClassroomAccess](apps/webapp/app/utils/helpers.js))

```javascript
async function assertClassroomAccess({
  request,
  classroomSlug,
  allowedRoles = [],
  resourceOwnerId = null,
  selfAccessRoles = [],
  requireOwnership = false,
  resourceType,
  attemptedAction,
  metadata = {}
}) {
  // 1. Authenticate user from session
  // 2. Get classroom membership
  // 3. Check role-based access
  // 4. Check resource ownership if applicable
  // 5. Log denied access attempts
  // 6. Return { userId, classroom, membership, isResourceOwner }
}
```

---

## Security & Compliance

### Security Features

**Authentication Security**
- JWT tokens with expiration
- Secure HTTP-only cookies
- CSRF protection
- GitHub OAuth with state parameter
- Token refresh mechanism

**Authorization Security**
- Role-based access control (RBAC)
- Resource ownership validation
- Path validation for file access
- Self-access patterns
- Audit logging for sensitive operations

**Data Security**
- Database connection encryption
- Secrets in `.env` file (not in code)
- Password hashing (if used)
- API key encryption in database
- Webhook signature verification

**Code-Aware Quiz Security**
- Sandboxed execution environment
- Path validation (no system file access)
- Limited command execution
- No network access from sandbox
- Automatic cleanup after quiz
- Repository size limits
- Timeout enforcement

### Known Security Concerns

**From SECURITY.md:**

1. **Admin Route Authentication** (Being addressed)
   - Some admin routes previously lacked proper authentication checks
   - Solution: `assertClassroomAccess` being added to all routes

2. **Stripe Webhook Verification** (Being addressed)
   - Webhook signature verification needed enhancement
   - Solution: Proper signature validation implemented

3. **FERPA Compliance Considerations**
   - Student data privacy (grades, PII)
   - Solution: Audit logging, data masking in analytics

### FERPA Compliance

**Student Data Protection**
- Access control: Students see only their own data
- Audit logging: Track who views what
- Data masking: Analytics exclude PII
- Secure data transmission: HTTPS everywhere

**Data Retention**
- Configurable data retention policies
- Ability to delete student data
- Export student data (data portability)

### Audit System

**Audit Log Types** ([audit-log.service.js](packages/services/src/audit-log.service.js))

| Action | When Logged | Purpose |
|--------|-------------|---------|
| `ACCESS_DENIED` | Unauthorized access attempt | Security monitoring |
| `GRADE_RELEASED` | Grades made visible | Track data disclosure |
| `TOKEN_GRANTED` | Tokens manually awarded | Financial audit trail |
| `EXTENSION_APPROVED` | Deadline extended | Academic policy compliance |

**Audit Log Structure**
```javascript
{
  user_id: 12345,
  organization_id: 67890,
  action: 'ACCESS_DENIED',
  resource_type: 'STUDENT_GRADES',
  resource_id: 'student-123',
  metadata: {
    route: '/admin/org/grades',
    required_role: 'TEACHER',
    ip_address: '1.2.3.4'
  },
  created_at: '2024-01-15T10:30:00Z'
}
```

---

## Development & Deployment

### Development Setup

**Prerequisites**
- Node.js 22+
- Docker (for PostgreSQL)
- GitHub account (for OAuth testing)

**Initial Setup**
```bash
# Clone repository
git clone https://github.com/your-org/classmoji.git
cd classmoji/apps

# Install dependencies
npm install

# Initialize secrets (interactive)
npm run init

# Start PostgreSQL via Docker
npm run db:start

# Generate Prisma client
npm run db:generate

# Run database migrations
npm run db:deploy

# Seed database with sample data
npm run db:seed

# Start all services in development mode
npm run dev
```

**Development Commands**

```bash
# Start all services (concurrent)
npm run dev

# Individual services
npm run web:dev          # React webapp on :3000
npm run ai-agent:dev     # AI agent on :6000
npm run hook:dev         # Hook station on :3001
npm run trigger:dev      # Trigger.dev workflows

# Database operations
npm run db:generate      # Generate Prisma client
npm run db:deploy        # Run migrations
npm run db:reset         # Reset database (destructive)
npm run db:seed          # Seed sample data
npm run db:studio        # Open Prisma Studio

# Testing
npm run web:test         # Run Playwright tests
npm run web:test:ui      # Playwright UI mode

# Build & Production
npm run web:build        # Build React app
npm run web:start        # Serve production build
```

### Environment Variables

**Required Secrets** (via `.env` file)

```bash
# Database
DATABASE_URL="postgresql://user:pass@localhost:5432/classmoji"

# GitHub
GITHUB_CLIENT_ID="your-github-oauth-client-id"
GITHUB_CLIENT_SECRET="your-github-oauth-secret"
GITHUB_APP_ID="your-github-app-id"
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----..."
GITHUB_WEBHOOK_SECRET="your-webhook-secret"

# Stripe
STRIPE_SECRET_KEY="sk_test_..."
STRIPE_WEBHOOK_SECRET="whsec_..."
STRIPE_PRO_PRICE_ID="price_..."

# LLM Providers (System defaults)
OPENAI_API_KEY="sk-..."
ANTHROPIC_API_KEY="sk-ant-..."

# JWT
JWT_SECRET="your-random-secret-string"

# Trigger.dev
TRIGGER_API_KEY="tr_..."
TRIGGER_API_URL="https://api.trigger.dev"
# Public Trigger address the generated autograding workflow reports to from
# GitHub Actions. Unset = Trigger.dev cloud. Never the worker-internal URL.
TRIGGER_PUBLIC_API_URL=""
```

### Testing

**Playwright E2E Tests** ([apps/webapp/tests/](apps/webapp/tests/))

**Test Structure**
```javascript
// apps/webapp/tests/auth.spec.js
test.describe('Authentication', () => {
  test('should login with GitHub', async ({ page }) => {
    // Test GitHub OAuth flow
  });

  test('should logout successfully', async ({ page }) => {
    // Test logout
  });
});
```

**Running Tests**
```bash
# Run all tests
npm run web:test

# Run in UI mode (interactive)
npm run web:test:ui

# Run specific test file
npx playwright test auth.spec.js

# Run with debugging
npx playwright test --debug
```

**Test Coverage Areas**
- Authentication (login/logout)
- Assignment creation and management
- Grading workflow
- Quiz taking and grading
- Token transactions
- Team management
- Settings updates

### Deployment

**Production Architecture**
```
Load Balancer
  ├── webapp (Vercel/Netlify)
  ├── ai-agent (Railway/Fly.io)
  └── hook-station (Railway/Fly.io)

Database: PostgreSQL (Neon/Supabase)
Background: Trigger.dev (cloud)
Secrets: Environment variables
```

**Deployment Checklist**
- [ ] Set all environment variables in production
- [ ] Configure GitHub App with production webhooks
- [ ] Set Stripe webhook endpoints to production URLs
- [ ] Enable HTTPS everywhere
- [ ] Configure CORS for production domains
- [ ] Set up database backups
- [ ] Configure monitoring (Sentry, etc.)
- [ ] Test webhook delivery
- [ ] Verify GitHub OAuth redirect URLs
- [ ] Test quiz agent WebSocket connection

### Monitoring & Logging

**Application Logging**
- Fastify logger (pino) in API
- Console logging in webapp (development)
- Structured logging for production

**Error Tracking**
- Consider Sentry integration (future)
- Audit logs for security events

**Performance Monitoring**
- API response times
- Database query performance (Prisma)
- Background task duration (Trigger.dev)

---

## Unique Features Summary

### What Makes Classmoji Special

1. **Emoji-Based Grading** 🎯⭐🚀
   - More engaging than traditional numeric grades
   - Visual feedback that's approachable
   - Customizable per organization

2. **Code-Aware AI Quizzes** 🤖
   - AI explores student's actual code repository
   - Evidence-based questioning with code snippets
   - Real-time exploration streaming to student
   - Revolutionary approach to assessment

3. **Token Economy** 💰
   - Gamification through earning and spending tokens
   - Incentivizes timely submission
   - Student agency in deadline management

4. **GitHub-Native Workflow** 🐙
   - Deep integration with GitHub workflows
   - Automatic repository and issue management
   - Familiar environment for CS students
   - Contribution tracking for group work

5. **Multi-Tier LLM Support** 🧠
   - Use OpenAI or Anthropic
   - Organization API keys or system defaults
   - Standard and code-aware quiz modes
   - Flexible configuration per quiz

6. **Comprehensive Role System** 👥
   - Owner, Assistant, Student roles
   - Self-access patterns (students see own data)
   - Resource ownership validation
   - Audit logging for compliance

7. **Background Task Processing** ⚙️
   - Reliable bulk operations
   - Real-time progress tracking
   - Webhook-triggered workflows
   - Scalable architecture

8. **Modern Monorepo Architecture** 📦
   - Clear separation of concerns
   - Shared packages for reusability
   - Turbo for build caching
   - Type-safe across services

---

## Future Enhancements

### Potential Features

**Enhanced Analytics**
- Student engagement scoring
- Predictive analytics (at-risk students)
- Comparative analytics (cohort vs cohort)
- Grade distribution visualizations

**Advanced Quiz Features**
- Multi-attempt quizzes with best score
- Timed quizzes with strict enforcement
- Collaborative quizzes (pair programming)
- Video-based quiz responses

**Improved Team Features**
- Peer evaluation system
- Team formation algorithms
- Sprint planning tools
- Kanban boards per team

**Communication Tools**
- In-platform messaging
- Announcement system
- Office hours scheduling
- Discussion forums

**Mobile Support**
- Native mobile apps (React Native)
- Progressive Web App (PWA)
- Mobile-optimized quiz taking
- Push notifications

**Integration Expansions**
- GitLab support (alongside GitHub)
- LMS integration (Canvas, Blackboard)
- Plagiarism detection (Moss, Turnitin)
- IDE plugins (VS Code extension)

---

## Conclusion

Classmoji is a comprehensive, modern educational technology platform that brings together the best of classroom management, automated grading, AI-powered assessment, and deep GitHub integration. Its unique features like emoji grading and code-aware quizzes make it particularly well-suited for computer science education, while its flexible architecture allows for future expansion and customization.

The platform demonstrates strong technical foundations with its monorepo architecture, type-safe codebase, microservices approach, and thoughtful security considerations. Whether you're an instructor looking for streamlined course management, a TA needing efficient grading tools, or a student wanting engaging learning experiences, Classmoji provides the tools and workflows to support modern CS education.

---

## Quick Reference

### Key File Locations

```
apps/
  webapp/app/routes/              # All React Router routes
    admin.$org/                   # Admin dashboard
    student.$org/                 # Student dashboard
    admin.$org.settings*/         # Settings pages
  ai-agent/src/                   # AI WebSocket service (quiz, syllabus bot, prompt assistant)
  hook-station/src/webhooks/      # GitHub & Stripe webhooks

packages/
  database/prisma/schema.prisma   # Database schema
  llm/src/                        # LLM functionality
  services/src/                   # Shared services
  utils/src/                      # Shared utilities
  tasks/src/workflows/            # Trigger.dev tasks
```

### Important Utilities

- **Authorization**: `assertClassroomAccess()` in `apps/webapp/app/utils/helpers.ts`
- **Grade Calculation**: `calculateGrade()` in `apps/webapp/app/utils/helpers.ts`
- **GitHub Service**: `packages/services/src/github.service.js`
- **Token Service**: `packages/services/src/token.service.js`
- **Stripe Service**: `packages/services/src/stripe.service.js`

### External Documentation

- React Router: https://reactrouter.com/
- Fastify: https://fastify.dev/
- Prisma: https://www.prisma.io/docs
- Trigger.dev: https://trigger.dev/docs
- GitHub API: https://docs.github.com/en/rest
- Stripe API: https://stripe.com/docs/api

---

**Document Version**: 1.0
**Last Updated**: 2025-11-07
**Maintained By**: Classmoji Development Team
