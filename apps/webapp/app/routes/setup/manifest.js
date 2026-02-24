export function buildManifest(baseUrl, name) {
  const isLocalhost = baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1');
  return {
    name,
    url: baseUrl,
    ...(isLocalhost ? {} : {
      hook_attributes: { url: `${baseUrl}/api/github-webhook`, active: true },
      default_events: ['issues', 'organization'],
    }),
    redirect_url: `${baseUrl}/setup/callback`,
    callback_urls: [`${baseUrl}/api/auth/callback/github`],
    description: 'GitHub App for Classmoji classroom management',
    public: true,
    default_permissions: {
      actions: 'write',
      administration: 'write',
      contents: 'write',
      emails: 'read',
      issues: 'write',
      members: 'write',
      metadata: 'read',
      organization_administration: 'write',
      organization_hooks: 'write',
      organization_projects: 'write',
      pages: 'write',
      pull_requests: 'write',
      repository_hooks: 'write',
      workflows: 'write',
    },
  };
}
