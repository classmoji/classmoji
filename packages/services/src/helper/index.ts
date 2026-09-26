import { parseScoreEmoji } from '@classmoji/utils';
import { getGitProvider } from '../git/index.ts';
import ClassmojiService from '../classmoji/index.ts';

interface HelperGitOrganization {
  provider: string;
  login: string;
  github_installation_id?: string | null;
  access_token?: string | null;
  base_url?: string | null;
  gitlab_group_id?: string | null;
  [key: string]: unknown;
}

interface DeleteRepositoryPayload {
  id?: string;
  name: string;
  gitOrganization: HelperGitOrganization;
  deleteFromGithub?: boolean;
  /**
   * When set, the row is deleted with `gitRepo.deleteInClassroom`, so it is
   * only removed if it belongs to this classroom.
   */
  classroomId?: string;
}

/**
 * Add or remove one grader on one submission of a classroom. Only ids come in;
 * the repo name, the issue number and the grader's login are read from the
 * stored rows.
 */
interface ClassroomGraderPayload {
  classroomId: string;
  /** The classroom's own git organization — the one its repos live in. */
  gitOrganization: HelperGitOrganization;
  gitRepoAssignmentId: unknown;
  graderId: unknown;
  /** Narrow the submission to one Repository (the repository page). */
  repositoryId?: string;
  /** Narrow the submission to one Assignment (the assignment page). */
  assignmentId?: string;
}

export type AddGraderInClassroomResult =
  | { status: 'added' | 'already_assigned'; graderLogin: string }
  | { status: 'submission_not_found' | 'grader_not_eligible' };

export type RemoveGraderInClassroomResult =
  | { status: 'removed'; graderLogin: string }
  | { status: 'submission_not_found' | 'grader_not_assigned' };

interface GitRepoAssignmentGraderPayload {
  repoName: string;
  gitOrganization: HelperGitOrganization;
  /** Null for a REPO-mode submission: there is no issue to assign on GitHub. */
  githubIssueNumber: number | null;
  graderLogin: string;
  graderId: string;
  gitRepoAssignmentId: string;
}

interface HelperClassroomRef {
  id: string;
}

interface GitRepoAssignmentRef {
  id: string;
  studentId?: string | null;
  teamId?: string | null;
}

interface GradeAssignmentPayload {
  classroom: HelperClassroomRef;
  gitRepoAssignment: GitRepoAssignmentRef;
  graderId: string;
  grade: string;
  studentId?: string;
  teamId?: string;
}

interface TokenAssignmentPayload {
  organization: HelperClassroomRef;
  gitRepoAssignment: GitRepoAssignmentRef;
  grade: string;
  studentId: string;
}

interface TeamTokenAssignmentPayload extends Omit<TokenAssignmentPayload, 'studentId'> {
  teamId: string;
}

interface EmojiMappingWithTokens {
  emoji: string;
  extra_tokens: number;
}

interface AssignmentGradeRef {
  id: string;
}

interface TokenTransactionRef {
  id: string;
  amount: number;
}

interface TeamMembershipRef {
  user_id: string;
}

interface TeamWithMemberships {
  memberships?: TeamMembershipRef[] | null;
}

interface GradeWithTokenTransaction {
  id: string;
  emoji: string;
  token_transaction?: TokenTransactionRef | null;
}

interface RemoveGradePayload {
  classroom: HelperClassroomRef;
  gitRepoAssignment: GitRepoAssignmentRef;
  grade: GradeWithTokenTransaction;
}

class HelperService {
  static async deleteRepository(payload: DeleteRepositoryPayload): Promise<unknown> {
    try {
      const { name: repoName, gitOrganization, deleteFromGithub } = payload;
      if (deleteFromGithub) {
        const gitProvider = getGitProvider(gitOrganization);
        await gitProvider.deleteRepository(gitOrganization.login, repoName);
      }
      if (payload?.id && payload.classroomId) {
        return ClassmojiService.gitRepo.deleteInClassroom(payload.id, payload.classroomId);
      }
      if (payload?.id) return ClassmojiService.gitRepo.deleteById(payload.id);
    } catch (error: unknown) {
      console.error('Error deleting git_repo:', error);
      throw error;
    }
  }

  static async addGraderToGitRepoAssignment(
    payload: GitRepoAssignmentGraderPayload
  ): Promise<unknown> {
    const {
      repoName,
      gitOrganization,
      githubIssueNumber,
      graderLogin,
      graderId,
      gitRepoAssignmentId,
    } = payload;

    if (githubIssueNumber != null) {
      const gitProvider = getGitProvider(gitOrganization);
      await gitProvider.addIssueAssignees(gitOrganization.login, repoName, githubIssueNumber, [
        graderLogin,
      ]);
    }

    return ClassmojiService.gitRepoAssignmentGrader.addGraderToAssignment(
      gitRepoAssignmentId,
      graderId
    );
  }

  static async removeGraderFromGitRepoAssignment(
    payload: GitRepoAssignmentGraderPayload
  ): Promise<unknown> {
    const {
      repoName,
      gitOrganization,
      githubIssueNumber,
      graderLogin,
      graderId,
      gitRepoAssignmentId,
    } = payload;

    if (githubIssueNumber != null) {
      const gitProvider = getGitProvider(gitOrganization);
      await gitProvider.removeIssueAssignees(gitOrganization.login, repoName, githubIssueNumber, [
        graderLogin,
      ]);
    }

    return ClassmojiService.gitRepoAssignmentGrader.removeGraderFromAssignment(
      gitRepoAssignmentId,
      graderId
    );
  }

  /**
   * Add a grader to a submission of this classroom, from ids alone.
   *
   * The submission is loaded from this classroom (optionally narrowed to a
   * repository or an assignment); its stored repo name and issue number are the
   * ones the provider call uses. The grader must be in this classroom's grader
   * pool (`gitRepoAssignmentGrader.findEligibleGrader`), and their stored login
   * is the one assigned. Nothing reaches the provider or the database unless
   * both checks pass. Someone already on the submission is left as is,
   * including when a concurrent add inserts the row first (P2002).
   */
  static async addGraderInClassroom(
    payload: ClassroomGraderPayload
  ): Promise<AddGraderInClassroomResult> {
    const { classroomId, gitOrganization, gitRepoAssignmentId, graderId } = payload;

    const submission = await ClassmojiService.gitRepoAssignment.findByIdInClassroom(
      gitRepoAssignmentId,
      classroomId,
      { repositoryId: payload.repositoryId, assignmentId: payload.assignmentId }
    );
    if (!submission) return { status: 'submission_not_found' };

    const grader = await ClassmojiService.gitRepoAssignmentGrader.findEligibleGrader(
      classroomId,
      graderId
    );
    if (!grader?.login) return { status: 'grader_not_eligible' };

    if (submission.graders.some(g => g.grader_id === grader.id)) {
      return { status: 'already_assigned', graderLogin: grader.login };
    }

    try {
      await this.addGraderToGitRepoAssignment({
        repoName: submission.git_repo.name,
        gitOrganization,
        githubIssueNumber: submission.provider_issue_number,
        graderLogin: grader.login,
        graderId: grader.id,
        gitRepoAssignmentId: submission.id,
      });
    } catch (error) {
      // A concurrent add of the same grader won the race between the check
      // above and the insert: the (submission, grader) row is unique, so the
      // grader is on the submission either way. Adding the same GitHub
      // assignee twice is a no-op there too.
      if ((error as { code?: string })?.code === 'P2002') {
        return { status: 'already_assigned', graderLogin: grader.login };
      }
      throw error;
    }
    return { status: 'added', graderLogin: grader.login };
  }

  /**
   * Remove a grader from a submission of this classroom, from ids alone.
   *
   * The submission is loaded from this classroom as in `addGraderInClassroom`;
   * the grader is taken from the submission's own grader rows (so someone who
   * has since left the grader pool can still be removed), and their stored
   * login is the one unassigned on the provider.
   */
  static async removeGraderInClassroom(
    payload: ClassroomGraderPayload
  ): Promise<RemoveGraderInClassroomResult> {
    const { classroomId, gitOrganization, gitRepoAssignmentId, graderId } = payload;

    const submission = await ClassmojiService.gitRepoAssignment.findByIdInClassroom(
      gitRepoAssignmentId,
      classroomId,
      { repositoryId: payload.repositoryId, assignmentId: payload.assignmentId }
    );
    if (!submission) return { status: 'submission_not_found' };

    const assigned =
      typeof graderId === 'string' && graderId
        ? submission.graders.find(g => g.grader_id === graderId)
        : undefined;
    if (!assigned?.grader?.login) return { status: 'grader_not_assigned' };

    await this.removeGraderFromGitRepoAssignment({
      repoName: submission.git_repo.name,
      gitOrganization,
      githubIssueNumber: submission.provider_issue_number,
      graderLogin: assigned.grader.login,
      graderId: assigned.grader_id,
      gitRepoAssignmentId: submission.id,
    });
    return { status: 'removed', graderLogin: assigned.grader.login };
  }

  /**
   * If the assignment has an open (IN_REVIEW) regrade request, remove the grades
   * that predate the request so a fresh grade replaces — rather than averages
   * with — the original. Grades applied after the request (deliberate multi-emoji
   * grading during the re-grade) are left untouched. Token rewards are reversed via
   * `removeGradeFromGitRepoAssignment`.
   */
  static async clearGradesForOpenRegradeRequest(
    classroom: HelperClassroomRef,
    gitRepoAssignment: GitRepoAssignmentRef
  ): Promise<void> {
    const openRequest = await ClassmojiService.regradeRequest.findOpenByAssignmentId(
      gitRepoAssignment.id
    );
    if (!openRequest) return;

    const grades = await ClassmojiService.assignmentGrade.findByAssignmentId(gitRepoAssignment.id);
    const staleGrades = grades.filter(grade => grade.created_at <= openRequest.created_at);

    for (const grade of staleGrades) {
      await this.removeGradeFromGitRepoAssignment({ classroom, gitRepoAssignment, grade });
    }
  }

  static async addGradeToGitRepoAssignment(payload: GradeAssignmentPayload): Promise<void> {
    const { classroom, gitRepoAssignment, graderId, grade, studentId, teamId } = payload;

    // When a submission has an open resubmit (regrade) request, a new grade should
    // replace the original grade rather than be averaged with it. Clear the grades
    // captured at request time before adding the new one. The request's
    // `previous_grade` snapshot keeps those emojis visible in the "Previous Grade"
    // column for reference.
    await this.clearGradesForOpenRegradeRequest(classroom, gitRepoAssignment);

    // Only emojis in the classroom's grading scale are grades. A classroom
    // with no scale yet (fresh import) accepts anything, as before.
    const scale = (await ClassmojiService.emojiMapping.findByClassroomId(
      classroom.id,
      true
    )) as EmojiMappingWithTokens[];
    if (scale.length > 0 && !scale.some(mapping => mapping.emoji === grade)) {
      throw new Error(`"${grade}" is not in this classroom's grading scale`);
    }

    // A numeric score is one number per grader, never a stack: a grader's new
    // score replaces the score they gave before (tokens reversed with it).
    // Other graders' scores stay and average, as separate opinions should.
    if (parseScoreEmoji(grade) !== null) {
      const existing = await ClassmojiService.assignmentGrade.findByAssignmentId(
        gitRepoAssignment.id
      );
      for (const previous of existing) {
        if (previous.grader_id !== graderId) continue;
        if (parseScoreEmoji(previous.emoji) === null) continue;
        if (previous.emoji === grade) return;
        try {
          await this.removeGradeFromGitRepoAssignment({
            classroom,
            gitRepoAssignment: { id: gitRepoAssignment.id, studentId, teamId },
            grade: previous,
          });
        } catch (error) {
          // Already removed by a concurrent request (a double submit from the
          // same field): nothing to replace any more, carry on.
          if ((error as { code?: string })?.code !== 'P2025') throw error;
        }
      }
    }

    if (await ClassmojiService.assignmentGrade.doesGradeExist(gitRepoAssignment.id, grade)) {
      return;
    }

    const assignmentGrade = await ClassmojiService.assignmentGrade.addGrade(
      gitRepoAssignment.id,
      graderId,
      grade
    );

    if (studentId) {
      this.assignTokensToStudent(
        {
          organization: classroom,
          gitRepoAssignment,
          grade,
          studentId,
        },
        assignmentGrade
      );
    } else if (teamId) {
      this.assignTokensToTeam(
        {
          organization: classroom,
          gitRepoAssignment,
          grade,
          teamId,
        },
        assignmentGrade
      );
    }
  }

  static async assignTokensToStudent(
    payload: TokenAssignmentPayload,
    assignmentGrade: AssignmentGradeRef
  ): Promise<void> {
    const { organization, gitRepoAssignment, grade } = payload;

    const emojiMapping = (await ClassmojiService.emojiMapping.findByClassroomId(
      organization.id,
      true
    )) as EmojiMappingWithTokens[];
    const emoji = emojiMapping.find(mapping => mapping.emoji === grade);

    if (!emoji) return;

    if (emoji.extra_tokens > 0) {
      const data = {
        classroomId: organization.id,
        studentId: payload.studentId,
        amount: emoji.extra_tokens,
        description: `Tokens for getting a ${grade}.`,
        repositoryAssignmentId: gitRepoAssignment.id,
      };

      const tokenTransaction = await ClassmojiService.token.assignToStudent(data);

      await ClassmojiService.assignmentGrade.update(assignmentGrade.id, {
        token_transaction_id: tokenTransaction.id,
      });
    }
  }

  static async assignTokensToTeam(
    payload: TeamTokenAssignmentPayload,
    assignmentGrade: AssignmentGradeRef
  ): Promise<void> {
    const { organization, gitRepoAssignment, grade, teamId } = payload;

    const emojiMapping = (await ClassmojiService.emojiMapping.findByClassroomId(
      organization.id,
      true
    )) as EmojiMappingWithTokens[];
    const emoji = emojiMapping.find(mapping => mapping.emoji === grade);

    if (!emoji) return;

    if (emoji.extra_tokens > 0) {
      const team = (await ClassmojiService.team.findById(teamId)) as TeamWithMemberships | null;
      if (!team || !team.memberships || team.memberships.length === 0) return;

      let firstTransaction = null;

      for (const membership of team.memberships) {
        const data = {
          classroomId: organization.id,
          studentId: membership.user_id,
          amount: emoji.extra_tokens,
          description: `Tokens for getting a ${grade}.`,
          repositoryAssignmentId: gitRepoAssignment.id,
        };

        const tokenTransaction = await ClassmojiService.token.assignToStudent(data);

        if (!firstTransaction) {
          firstTransaction = tokenTransaction;
        }
      }

      if (firstTransaction) {
        await ClassmojiService.assignmentGrade.update(assignmentGrade.id, {
          token_transaction_id: firstTransaction.id,
        });
      }
    }
  }

  static async removeGradeFromGitRepoAssignment(payload: RemoveGradePayload): Promise<void> {
    const { classroom, gitRepoAssignment, grade } = payload;

    await ClassmojiService.assignmentGrade.removeGrade(grade.id);
    // Remove tokens
    if (!grade.token_transaction) return;

    const studentId = gitRepoAssignment.studentId;
    const teamId = gitRepoAssignment.teamId;

    if (studentId) {
      const data = {
        classroomId: classroom.id,
        studentId,
        amount: grade.token_transaction.amount * -1,
        description: `Removing ${grade.emoji}.`,
        repositoryAssignmentId: gitRepoAssignment.id,
        type: 'REMOVAL',
      };

      ClassmojiService.token.assignToStudent(data);
    } else if (teamId) {
      const team = (await ClassmojiService.team.findById(teamId)) as TeamWithMemberships | null;
      if (!team || !team.memberships) return;

      for (const membership of team.memberships) {
        const data = {
          classroomId: classroom.id,
          studentId: membership.user_id,
          amount: grade.token_transaction.amount * -1,
          description: `Removing ${grade.emoji}.`,
          repositoryAssignmentId: gitRepoAssignment.id,
          type: 'REMOVAL',
        };

        ClassmojiService.token.assignToStudent(data);
      }
    }
  }
}

export default HelperService;
