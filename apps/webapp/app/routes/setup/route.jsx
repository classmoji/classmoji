import { useOutlet } from 'react-router';
import { Button } from 'antd';
import { Logo } from '@classmoji/ui-components';
import { buildManifest } from './manifest.js';

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const error = url.searchParams.get('error');

  const host = request.headers.get('host');
  const baseUrl = process.env.WEBAPP_URL || `http://${host}`;
  const name = `Classmoji-${Math.random().toString(36).slice(2, 8)}`;
  const manifest = buildManifest(baseUrl, name);

  return { manifest: JSON.stringify(manifest), error };
};

const errorMessages = {
  conversion_failed: 'Github could not complete app creation. Please try again.',
  no_code: 'Github did not return a valid code. Please try again.',
  network_error: 'A network error occurred. Please try again.',
  incomplete_data: 'Incomplete data received from Github. Please try again.',
};

const SetupPage = ({ loaderData }) => {
  const outlet = useOutlet();
  if (outlet) return outlet;

  const { manifest, error } = loaderData;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-[450px]">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <Logo size={48} />
          </div>
          <p className="text-gray-600 dark:text-gray-400">
            Classmoji requires a GitHub App to manage classroom repositories, issues, and workflows.
            Click below to create one automatically.
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
            <p className="text-sm text-red-700 dark:text-red-400">
              {errorMessages[error] ?? `Error: ${error}`}
            </p>
          </div>
        )}

        <form method="POST" action="https://github.com/settings/apps/new" className="w-full">
          <input type="hidden" name="manifest" value={manifest} />
          <Button type="primary" htmlType="submit" block>
            Create GitHub App on Github
          </Button>
        </form>

        <p className="mt-4 text-center text-gray-500 dark:text-gray-500">
          You will be redirected to Github to complete app creation. Classmoji will automatically
          configure itself when you return.
        </p>
      </div>
    </div>
  );
};

export default SetupPage;
