import { simpleGit } from 'simple-git';
import fs from 'fs/promises';
import path from 'path';

interface CodebaseSession {
  path: string;
  createdAt: Date;
  repoName: string;
  orgLogin: string;
}

class CodebaseManager {
  private codebasesDir: string;
  private activeSessions: Map<string, CodebaseSession>;

  constructor() {
    this.codebasesDir = path.join(process.cwd(), '.codebases');
    this.activeSessions = new Map();
  }

  async cloneForAttempt(attemptId: string, orgLogin: string, repoName: string, accessToken: string): Promise<string> {
    const codebasePath = path.join(this.codebasesDir, `attempt-${attemptId}`);

    // Return if already cloned
    if (this.activeSessions.has(attemptId)) {
      return this.activeSessions.get(attemptId)!.path;
    }

    // Ensure directory exists
    await fs.mkdir(this.codebasesDir, { recursive: true });

    // Clone repository
    const git = simpleGit();
    const remote = `https://x-access-token:${accessToken}@github.com/${orgLogin}/${repoName}.git`;

    await git.clone(remote, codebasePath);

    // Track session
    this.activeSessions.set(attemptId, {
      path: codebasePath,
      createdAt: new Date(),
      repoName,
      orgLogin
    });

    // Auto-cleanup after 2 hours
    setTimeout(() => this.cleanup(attemptId), 2 * 60 * 60 * 1000);

    return codebasePath;
  }

  getCodebasePath(attemptId: string): string | null {
    return this.activeSessions.get(attemptId)?.path || null;
  }

  async cleanup(attemptId: string): Promise<void> {
    const session = this.activeSessions.get(attemptId);
    if (!session) return;

    try {
      await fs.rm(session.path, { recursive: true, force: true });
      this.activeSessions.delete(attemptId);
    } catch (error: any) {
      console.error(`[CodebaseManager] Cleanup failed for ${attemptId}:`, error);
    }
  }

  // Cleanup old codebases periodically
  async cleanupOld(maxAgeHours: number = 4): Promise<void> {
    const now = new Date();
    const maxAge = maxAgeHours * 60 * 60 * 1000;

    for (const [attemptId, session] of this.activeSessions.entries()) {
      if (now.getTime() - session.createdAt.getTime() > maxAge) {
        await this.cleanup(attemptId);
      }
    }
  }
}

export const codebaseManager = new CodebaseManager();

// Cleanup old codebases every hour
setInterval(() => codebaseManager.cleanupOld(), 60 * 60 * 1000);
