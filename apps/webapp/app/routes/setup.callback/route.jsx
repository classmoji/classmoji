import { useEffect } from 'react';
import { redirect } from 'react-router';
import fs from 'fs';
import path from 'path';

function updateEnvFile(envPath, vars) {
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch {
    // File doesn't exist yet - start with empty content
  }

  for (const [key, value] of Object.entries(vars)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    const line = `${key}="${value}"`;
    if (regex.test(content)) {
      content = content.replace(regex, line);
    } else {
      if (content && !content.endsWith('\n')) content += '\n';
      content += `${line}\n`;
    }
  }

  fs.writeFileSync(envPath, content, 'utf-8');
}

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error || !code) {
    return redirect(`/setup?error=${encodeURIComponent(error || 'no_code')}`);
  }

  let appData;
  try {
    const response = await fetch(
      `https://api.github.com/app-manifests/${code}/conversions`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    );

    if (!response.ok) {
      const body = await response.text();
      console.error('[setup/callback] GitHub conversion failed:', response.status, body);
      return redirect('/setup?error=conversion_failed');
    }

    appData = await response.json();
  } catch (err) {
    console.error('[setup/callback] Network error during conversion:', err);
    return redirect('/setup?error=network_error');
  }

  const { id, pem, webhook_secret, name, client_id, client_secret } = appData;

  if (!id || !pem) {
    console.error('[setup/callback] Incomplete app data from GitHub:', { id: !!id, pem: !!pem });
    return redirect('/setup?error=incomplete_data');
  }

  const privateKeyBase64 = Buffer.from(pem).toString('base64');

  // Update in-memory immediately so the guard clears on the next request
  process.env.GITHUB_APP_ID = String(id);
  process.env.GITHUB_PRIVATE_KEY_BASE64 = privateKeyBase64;
  if (webhook_secret) process.env.GITHUB_WEBHOOK_SECRET = webhook_secret;
  if (name) process.env.GITHUB_APP_NAME = name;
  if (client_id) process.env.GITHUB_CLIENT_ID = client_id;
  if (client_secret) process.env.GITHUB_CLIENT_SECRET = client_secret;

  // Defer the .env write so the HTTP response is sent first.
  // Writing .env synchronously causes Vite to restart mid-request, dropping the
  // connection and triggering a browser retry with the same (now expired) code.
  //
  // Walk up from process.cwd() to find the monorepo root (contains turbo.json).
  // process.cwd() is apps/webapp/ when run via Turbo, not the repo root.
  function findMonorepoRoot(startDir) {
    let dir = startDir;
    while (true) {
      if (fs.existsSync(path.join(dir, 'turbo.json'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) return startDir;
      dir = parent;
    }
  }
  const envPath = path.join(findMonorepoRoot(process.cwd()), '.env');
  setTimeout(() => {
    updateEnvFile(envPath, {
      GITHUB_APP_ID: String(id),
      GITHUB_PRIVATE_KEY_BASE64: privateKeyBase64,
      ...(webhook_secret ? { GITHUB_WEBHOOK_SECRET: webhook_secret } : {}),
      ...(name ? { GITHUB_APP_NAME: name } : {}),
      ...(client_id ? { GITHUB_CLIENT_ID: client_id } : {}),
      ...(client_secret ? { GITHUB_CLIENT_SECRET: client_secret } : {}),
    });
  }, 500);

  return { success: true };
};

const SetupCallback = ({ loaderData }) => {
  const { success } = loaderData;

  useEffect(() => {
    if (success) {
      // Delay to allow the dev server to finish restarting after .env was written
      const timer = setTimeout(() => {
        window.location.href = '/';
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [success]);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center">
      <p className="text-gray-600 dark:text-gray-400">
        {success ? 'GitHub App configured! Redirecting...' : 'Configuring GitHub App...'}
      </p>
    </div>
  );
};

export default SetupCallback;
