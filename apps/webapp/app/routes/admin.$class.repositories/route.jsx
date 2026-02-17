import { PageHeader, TableActionButtons, TriggerProgress, SearchInput } from '~/components';

import { useParams, Await, useSearchParams, useRevalidator } from 'react-router';
import { useState, useEffect, Suspense, useCallback } from 'react';
import { Table, Button, Alert, Skeleton } from 'antd';
import { namedAction } from 'remix-utils/named-action';
import { tasks } from '@trigger.dev/sdk';
import { IconRefresh, IconTrash } from '@tabler/icons-react';
import dayjs from 'dayjs';
import { useDebounce } from '@uidotdev/usehooks';

import { ActionTypes } from '~/constants';
import { ClassmojiService, getGitProvider } from '@classmoji/services';
import { useGlobalFetcher } from '~/hooks';
import { waitForRunCompletion } from '~/utils/helpers';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';

/**
 * Fetch repositories from the organization using GitHub App installation token.
 * Supports server-side pagination and search via GitHub's GraphQL API.
 */
async function fetchOrgRepositories(gitOrganization, { page = 1, pageSize = 25, search = '' }) {
  const gitOrgLogin = gitOrganization?.login;

  if (!gitOrganization?.github_installation_id) {
    return {
      repositories: [],
      totalCount: 0,
      error: 'GitHub App not installed for this organization',
    };
  }

  try {
    const gitProvider = getGitProvider(gitOrganization);
    const octokit = await gitProvider.getOctokit();

    // If searching, use GitHub's search API which supports name filtering
    if (search) {
      const searchQuery = `org:${gitOrgLogin} ${search} in:name`;
      const response = await octokit.graphql(
        `
          query ($query: String!, $first: Int!, $after: String) {
            search(query: $query, type: REPOSITORY, first: $first, after: $after) {
              repositoryCount
              nodes {
                ... on Repository {
                  name
                }
              }
              pageInfo {
                endCursor
                hasNextPage
              }
            }
          }
        `,
        {
          query: searchQuery,
          first: pageSize,
          after: page > 1 ? btoa(`cursor:${(page - 1) * pageSize}`) : null,
        }
      );

      return {
        repositories: response.search.nodes,
        totalCount: response.search.repositoryCount,
        lastRefresh: new Date().toISOString(),
      };
    }

    // Without search, use organization repositories query with pagination
    // GitHub GraphQL uses cursor-based pagination, so we need to calculate the cursor
    // For simplicity, we'll fetch in chunks to get to the right page
    let afterCursor = null;

    // If not on page 1, we need to skip to the right position
    if (page > 1) {
      // Fetch just cursors to get to the right page
      const skipCount = (page - 1) * pageSize;
      let skipped = 0;

      while (skipped < skipCount) {
        const batchSize = Math.min(100, skipCount - skipped);
        const skipResponse = await octokit.graphql(
          `
            query ($org: String!, $first: Int!, $after: String) {
              organization(login: $org) {
                repositories(first: $first, after: $after, orderBy: {field: NAME, direction: ASC}) {
                  pageInfo {
                    endCursor
                    hasNextPage
                  }
                }
              }
            }
          `,
          {
            org: gitOrgLogin,
            first: batchSize,
            after: afterCursor,
          }
        );

        afterCursor = skipResponse.organization.repositories.pageInfo.endCursor;
        skipped += batchSize;

        if (!skipResponse.organization.repositories.pageInfo.hasNextPage) {
          break;
        }
      }
    }

    // Now fetch the actual page
    const response = await octokit.graphql(
      `
        query ($org: String!, $first: Int!, $after: String) {
          organization(login: $org) {
            repositories(first: $first, after: $after, orderBy: {field: NAME, direction: ASC}) {
              totalCount
              nodes {
                name
              }
              pageInfo {
                endCursor
                hasNextPage
              }
            }
          }
        }
      `,
      {
        org: gitOrgLogin,
        first: pageSize,
        after: afterCursor,
      }
    );

    return {
      repositories: response.organization.repositories.nodes,
      totalCount: response.organization.repositories.totalCount,
      lastRefresh: new Date().toISOString(),
    };
  } catch (error) {
    console.error('Failed to fetch repositories:', error);
    return { repositories: [], totalCount: 0, error: error.message };
  }
}

export const loader = async ({ request, params }) => {
  const { class: classSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'REPOSITORIES',
    action: 'view_repositories',
  });

  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get('page') || '1');
  const pageSize = parseInt(url.searchParams.get('pageSize') || '25');
  const search = url.searchParams.get('search') || '';

  const gitOrgLogin = classroom.git_organization?.login;

  // Return promise without awaiting - allows page to render immediately
  return {
    repositoriesPromise: fetchOrgRepositories(classroom.git_organization, {
      page,
      pageSize,
      search,
    }),
    gitOrgLogin,
    page,
    pageSize,
    search,
  };
};

// Skeleton loader for the repositories table only
const RepositoriesTableSkeleton = () => (
  <div className="space-y-4">
    <Skeleton active paragraph={{ rows: 8 }} />
  </div>
);

// Table component that renders when data is loaded
const RepositoriesTable = ({ data, gitOrgLogin, page, pageSize, search, onDelete, loading }) => {
  const { repositories, totalCount, lastRefresh, error } = data;
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedRepos, setSelectedRepos] = useState([]);
  const { fetcher } = useGlobalFetcher();
  const { class: classSlug } = useParams();

  // Clear selection when page/search changes
  useEffect(() => {
    setSelectedRepos([]);
  }, [page, search]);

  const deleteSelectedRepositories = () => {
    fetcher.submit(
      { deleteFromGithub: true, repositories: selectedRepos, classSlug },
      {
        method: 'delete',
        action: `/api/operation/?action=deleteRepositories`,
        encType: 'application/json',
      }
    );
  };

  const handleTableChange = pagination => {
    const newParams = new URLSearchParams(searchParams);
    newParams.set('page', pagination.current.toString());
    newParams.set('pageSize', pagination.pageSize.toString());
    setSearchParams(newParams);
  };

  const columns = [
    {
      title: 'Repository Name',
      dataIndex: 'name',
      key: 'name',
      width: '70%',
      render: name => <span className="font-medium text-gray-800 dark:text-gray-200">{name}</span>,
    },
    {
      title: 'Actions',
      dataIndex: 'actions',
      key: 'actions',
      width: '30%',
      render: (_, record) => {
        return (
          <TableActionButtons
            onView={() => {
              const url = `https://github.com/${gitOrgLogin}/${record.name}`;
              window.open(url, '_blank');
            }}
            onDelete={() => onDelete(record)}
          />
        );
      },
    },
  ];

  const rowSelection = {
    selectedRowKeys: selectedRepos.map(r => r.name),
    onChange: (_, selectedRows) => {
      setSelectedRepos(selectedRows);
    },
  };

  return (
    <>
      {/* Delete Selected Button - shown in header area */}
      {selectedRepos.length > 0 && (
        <div className="mb-4">
          <Button
            onClick={deleteSelectedRepositories}
            type="primary"
            danger
            icon={<IconTrash size={16} />}
          >
            Delete Selected ({selectedRepos.length})
          </Button>
        </div>
      )}

      {/* Search Results Summary */}
      {search && (
        <div className="mb-4 pb-4 border-b border-gray-200 dark:border-gray-700">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {totalCount} repositor{totalCount !== 1 ? 'ies' : 'y'} found
            <span className="ml-1">
              for &quot;
              <span className="font-medium text-gray-900 dark:text-gray-200">{search}</span>&quot;
            </span>
          </p>
        </div>
      )}

      {/* Error Alert */}
      {error && (
        <Alert
          type="error"
          message="Failed to load repositories"
          description={error}
          showIcon
          className="mb-4"
        />
      )}

      {/* Last Refresh Info */}
      <div className="mb-4">
        <p className="text-slate-600 dark:text-slate-400 italic text-sm">
          Last refreshed: {lastRefresh ? dayjs().to(dayjs(lastRefresh)) : 'Never'}
        </p>
      </div>

      <Table
        columns={columns}
        loading={{
          spinning: loading,
        }}
        rowSelection={{ ...rowSelection }}
        dataSource={repositories}
        rowHoverable={false}
        size="small"
        rowKey="name"
        onChange={handleTableChange}
        pagination={{
          current: page,
          pageSize: pageSize,
          total: totalCount,
          showSizeChanger: true,
          showQuickJumper: true,
          pageSizeOptions: ['10', '25', '50', '100'],
          showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} repositories`,
        }}
        locale={{
          emptyText: search ? (
            <div className="text-center py-8 text-gray-500">
              <div className="text-4xl mb-2">🔍</div>
              <div>No repositories found matching &quot;{search}&quot;</div>
              <div className="text-sm">Try adjusting your search terms</div>
            </div>
          ) : (
            <div className="text-center py-8 text-gray-500">
              <div className="text-4xl mb-2">📁</div>
              <div>No repositories found</div>
              <div className="text-sm">Refresh to load repositories from GitHub</div>
            </div>
          ),
        }}
        className="rounded-lg"
      />
    </>
  );
};

const GithubRepositories = ({ loaderData }) => {
  const { repositoriesPromise, gitOrgLogin, page, pageSize, search } = loaderData;
  const [searchParams, setSearchParams] = useSearchParams();
  const { revalidate, state } = useRevalidator();
  const [localSearch, setLocalSearch] = useState(search);
  const { fetcher } = useGlobalFetcher();
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Debounce the search value
  const debouncedSearch = useDebounce(localSearch, 300);

  // Sync local search with URL param when it changes externally
  useEffect(() => {
    setLocalSearch(search);
  }, [search]);

  // Update URL when debounced search changes
  useEffect(() => {
    // Only update if the debounced value differs from current URL param
    if (debouncedSearch !== search) {
      const newParams = new URLSearchParams(searchParams);
      if (debouncedSearch) {
        newParams.set('search', debouncedSearch);
      } else {
        newParams.delete('search');
      }
      newParams.set('page', '1'); // Reset to page 1 on search
      setSearchParams(newParams);
    }
  }, [debouncedSearch]);

  const handleSearchChange = value => {
    setLocalSearch(value);
  };

  const handleRefresh = () => {
    revalidate();
  };

  const deleteSingleRepository = useCallback(
    async repository => {
      setDeleteLoading(true);
      fetcher.submit(repository, {
        method: 'delete',
        action: `?/deleteSingleRepository`,
        encType: 'application/json',
      });
    },
    [fetcher]
  );

  // Handle delete completion
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data?.success) {
      setDeleteLoading(false);
      revalidate();
    } else if (fetcher.state === 'idle' && fetcher.data?.error) {
      setDeleteLoading(false);
    }
  }, [fetcher.state, fetcher.data, revalidate]);

  const isLoading = state === 'loading' || deleteLoading;

  return (
    <div className="space-y-6">
      <PageHeader title="GitHub Repositories" routeName="repositories">
        <div className="flex items-center gap-3">
          <Button
            icon={<IconRefresh size={16} />}
            type="primary"
            loading={isLoading}
            onClick={handleRefresh}
          >
            Refresh
          </Button>
        </div>
      </PageHeader>

      {/* Search Input - always visible */}
      <div className="flex items-center justify-between gap-4 mb-4">
        <SearchInput
          query={localSearch}
          setQuery={handleSearchChange}
          placeholder="Search repositories..."
          className="w-64"
        />
      </div>

      <TriggerProgress
        operation="DELETE_REPOS"
        validIdentifiers={['delete_repository']}
        callback={() => {
          revalidate();
        }}
      />

      <Suspense fallback={<RepositoriesTableSkeleton />}>
        <Await resolve={repositoriesPromise}>
          {resolvedData => (
            <RepositoriesTable
              data={resolvedData}
              gitOrgLogin={gitOrgLogin}
              page={page}
              pageSize={pageSize}
              search={search}
              onDelete={deleteSingleRepository}
              loading={isLoading}
            />
          )}
        </Await>
      </Suspense>
    </div>
  );
};

export const action = async ({ request, params }) => {
  const { class: classSlug } = params;

  const { classroom, userId } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'REPOSITORIES',
    action: 'manage_repositories',
  });

  return namedAction(request, {
    async deleteSingleRepository() {
      const data = await request.json();
      const repo = await ClassmojiService.repository.findByName(classSlug, data.name);

      const payload = {
        name: data.name,
        gitOrganization: classroom.git_organization,
        deleteFromGithub: true,
        id: repo?.id,
      };

      try {
        const run = await tasks.trigger('delete_repository', payload);

        await waitForRunCompletion(run.id);

        return {
          action: ActionTypes.DELETE_REPO,
          success: 'Repository deleted',
        };
      } catch (error) {
        console.error('delete_repository failed:', error);
        return {
          action: ActionTypes.DELETE_REPO,
          error: 'Failed to delete repository. Please try again.',
        };
      }
    },
  });
};

export default GithubRepositories;
