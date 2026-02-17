import { getGitProvider } from '../git/index.js';
import ClassmojiService from '../classmoji/index.js';

class HelperService {
  static async deleteRepository(payload) {
    try {
      const { name: repoName, gitOrganization, deleteFromGithub } = payload;
      if (deleteFromGithub) {
        const gitProvider = getGitProvider(gitOrganization);
        await gitProvider.deleteRepository(gitOrganization.login, repoName);
      }
      if (payload?.id) return ClassmojiService.repository.deleteById(payload.id);
    } catch (error) {
      console.error('Error deleting repository:', error);
      throw error;
    }
  }

  static async addGraderToRepositoryAssignment(payload) {
    const {
      repoName,
      gitOrganization,
      githubIssueNumber,
      graderLogin,
      graderId,
      repositoryAssignmentId,
    } = payload;

    const gitProvider = getGitProvider(gitOrganization);
    await gitProvider.addIssueAssignees(gitOrganization.login, repoName, githubIssueNumber, [
      graderLogin,
    ]);

    return ClassmojiService.repositoryAssignmentGrader.addGraderToAssignment(repositoryAssignmentId, graderId);
  }

  static async removeGraderFromRepositoryAssignment(payload) {
    const {
      repoName,
      gitOrganization,
      githubIssueNumber,
      graderLogin,
      graderId,
      repositoryAssignmentId,
    } = payload;

    const gitProvider = getGitProvider(gitOrganization);
    await gitProvider.removeIssueAssignees(gitOrganization.login, repoName, githubIssueNumber, [
      graderLogin,
    ]);

    return ClassmojiService.repositoryAssignmentGrader.removeGraderFromAssignment(repositoryAssignmentId, graderId);
  }

  static async addGradeToRepositoryAssignment(payload) {
    const { classroom, repositoryAssignment, graderId, grade, studentId, teamId } = payload;
    if (await ClassmojiService.assignmentGrade.doesGradeExist(repositoryAssignment.id, grade)) {
      return;
    }

    const assignmentGrade = await ClassmojiService.assignmentGrade.addGrade(repositoryAssignment.id, graderId, grade);

    if (studentId) {
      this.assignTokensToStudent({
        organization: classroom,
        repositoryAssignment,
        grade,
        studentId
      }, assignmentGrade);
    } else if (teamId) {
      this.assignTokensToTeam({
        organization: classroom,
        repositoryAssignment,
        grade,
        teamId
      }, assignmentGrade);
    }
  }

  static async assignTokensToStudent(payload, assignmentGrade) {
    const { organization, repositoryAssignment, grade } = payload;

    const emojiMapping = await ClassmojiService.emojiMapping.findByClassroomId(organization.id, true);
    const emoji = emojiMapping.find(mapping => mapping.emoji === grade);

    if (emoji.extra_tokens > 0) {
      const data = {
        classroomId: organization.id,
        studentId: payload.studentId,
        amount: emoji.extra_tokens,
        description: `Tokens for getting a ${grade}.`,
        repositoryAssignmentId: repositoryAssignment.id,
      };

      const tokenTransaction = await ClassmojiService.token.assignToStudent(data);

      await ClassmojiService.assignmentGrade.update(assignmentGrade.id, {
        token_transaction_id: tokenTransaction.id,
      });
    }
  }

  static async assignTokensToTeam(payload, assignmentGrade) {
    const { organization, repositoryAssignment, grade, teamId } = payload;

    const emojiMapping = await ClassmojiService.emojiMapping.findByClassroomId(organization.id, true);
    const emoji = emojiMapping.find(mapping => mapping.emoji === grade);

    if (emoji.extra_tokens > 0) {
      const team = await ClassmojiService.team.findById(teamId);
      if (!team || !team.memberships || team.memberships.length === 0) return;

      let firstTransaction = null;

      for (const membership of team.memberships) {
        const data = {
          classroomId: organization.id,
          studentId: membership.user_id,
          amount: emoji.extra_tokens,
          description: `Tokens for getting a ${grade}.`,
          repositoryAssignmentId: repositoryAssignment.id,
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

  static async removeGradeFromRepositoryAssignment(payload) {
    const { classroom, repositoryAssignment, grade } = payload;

    await ClassmojiService.assignmentGrade.removeGrade(grade.id);
    // Remove tokens
    if (!grade.token_transaction) return;

    const studentId = repositoryAssignment.studentId;
    const teamId = repositoryAssignment.teamId;

    if (studentId) {
      const data = {
        classroomId: classroom.id,
        studentId,
        amount: grade.token_transaction.amount * -1,
        description: `Removing ${grade.emoji}.`,
        repositoryAssignmentId: repositoryAssignment.id,
        type: 'REMOVAL',
      };

      ClassmojiService.token.assignToStudent(data);
    } else if (teamId) {
      const team = await ClassmojiService.team.findById(teamId);
      if (!team || !team.memberships) return;

      for (const membership of team.memberships) {
        const data = {
          classroomId: classroom.id,
          studentId: membership.user_id,
          amount: grade.token_transaction.amount * -1,
          description: `Removing ${grade.emoji}.`,
          repositoryAssignmentId: repositoryAssignment.id,
          type: 'REMOVAL',
        };

        ClassmojiService.token.assignToStudent(data);
      }
    }
  }
}

export default HelperService;
