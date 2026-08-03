import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Read the .dev-context file to get the current dev port for a service.
 * Returns null if the file doesn't exist or the service isn't found.
 */
export function getDevPort(service: 'pages' | 'slides' | 'webapp'): string | null {
  try {
    const devContextPath = path.join(__dirname, '../../../../.dev-context');
    const content = fs.readFileSync(devContextPath, 'utf-8');

    const serviceMap: Record<string, RegExp> = {
      pages: /Pages:\s+http:\/\/localhost:(\d+)/,
      slides: /Slides:\s+http:\/\/localhost:(\d+)/,
      webapp: /Webapp:\s+http:\/\/localhost:(\d+)/,
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
 * Get the pages base URL from .dev-context or use default.
 */
export function getPagesBaseURL(): string {
  return getDevPort('pages') || 'http://localhost:7100';
}

/**
 * Get the test classroom slug.
 * This should match a seeded classroom in the database.
 */
export function getTestClassroomSlug(): string {
  return process.env.TEST_CLASSROOM_SLUG || 'classmoji-dev-winter-2025';
}
