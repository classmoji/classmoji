import * as fs from 'fs';
import * as path from 'path';

/**
 * Read the .dev-context file to get the current dev port for a service.
 * Returns null if the file doesn't exist or the service isn't found.
 */
export function getDevPort(service: 'slides' | 'webapp' | 'api'): string | null {
  try {
    const devContextPath = path.join(__dirname, '../../../../.dev-context');
    const content = fs.readFileSync(devContextPath, 'utf-8');

    const serviceMap: Record<string, RegExp> = {
      slides: /Slides:\s+http:\/\/localhost:(\d+)/,
      webapp: /Webapp:\s+http:\/\/localhost:(\d+)/,
      api: /API:\s+http:\/\/localhost:(\d+)/,
    };

    const match = content.match(serviceMap[service]);
    if (match) {
      return `http://localhost:${match[1]}`;
    }
  } catch {
    // File doesn't exist or couldn't be read
  }
  return null;
}

/**
 * Get the slides base URL from .dev-context or use default.
 */
export function getSlidesBaseURL(): string {
  return getDevPort('slides') || 'http://localhost:6550';
}

/**
 * Get the test classroom slug.
 * This should match a seeded classroom in the database.
 * Default is 'classmoji-dev-winter-2025' from the massive-migration devport.
 */
export function getTestClassroomSlug(): string {
  return process.env.TEST_CLASSROOM_SLUG || 'classmoji-dev-winter-2025';
}

/**
 * Get the test classroom org (git org login).
 * Used for constructing content URLs.
 */
export function getTestClassroomOrg(): string {
  return process.env.TEST_CLASSROOM_ORG || 'CS-TestClassroom';
}

/**
 * Get the test classroom term.
 * Used for import functionality which requires org and term params.
 * Note: The term format is '25w' (short form), not 'winter-2025'.
 */
export function getTestClassroomTerm(): string {
  return process.env.TEST_CLASSROOM_TERM || '25w';
}
