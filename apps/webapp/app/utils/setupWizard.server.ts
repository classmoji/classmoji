import { redirect } from 'react-router';

/**
 * The first-run Github App wizard (`/setup` and its callback) is a local
 * development tool: it creates the App from a manifest and writes the result
 * to the repository's `.env`. It runs only on a development server
 * (`npm run web:dev`) with `SETUP_GITHUB_APP="true"`, the value `.env.example`
 * ships. Everywhere else the Github App values are configured by hand.
 */
export const setupWizardEnabled = (): boolean =>
  process.env.SETUP_GITHUB_APP === 'true' && process.env.NODE_ENV === 'development';

/**
 * The first statement of every setup loader and action: while the wizard is
 * off, the answer is a redirect to `/` before anything else runs.
 */
export const requireSetupWizard = (): void => {
  if (!setupWizardEnabled()) throw redirect('/');
};

/** `/setup` and the paths under it, and no other path that starts with the same letters. */
export const isSetupPath = (pathname: string): boolean =>
  pathname === '/setup' || pathname.startsWith('/setup/');
