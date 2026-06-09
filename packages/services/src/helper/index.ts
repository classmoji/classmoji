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
}

interface GitRepoAssignmentGraderPayload {
  repoName: string;
  gitOrganization: HelperGitOrganization;
  githubIssueNumber: number;
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

    const gitProvider = getGitProvider(gitOrganization);
    await gitProvider.addIssueAssignees(gitOrganization.login, repoName, githubIssueNumber, [
      graderLogin,
    ]);

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

    const gitProvider = getGitProvider(gitOrganization);
    await gitProvider.removeIssueAssignees(gitOrganization.login, repoName, githubIssueNumber, [
      graderLogin,
    ]);

    return ClassmojiService.gitRepoAssignmentGrader.removeGraderFromAssignment(
      gitRepoAssignmentId,
      graderId
    );
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
    const staleGrades = grades.filter(
      grade => grade.created_at <= openRequest.created_at
    );

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
        gitRepoAssignmentId: gitRepoAssignment.id,
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
          gitRepoAssignmentId: gitRepoAssignment.id,
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
        gitRepoAssignmentId: gitRepoAssignment.id,
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
          gitRepoAssignmentId: gitRepoAssignment.id,
          type: 'REMOVAL',
        };

        ClassmojiService.token.assignToStudent(data);
      }
    }
  }
}

export default HelperService;
