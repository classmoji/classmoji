import { Modal, Form, Input, Alert } from 'antd';
import { GITLAB_UNSUPPORTED, isGitLabClassroom } from '~/utils/gitlabGuard.server';
import { useNavigate, useParams } from 'react-router';
import { useEffect, useState, useRef } from 'react';
import { auth, tasks } from '@trigger.dev/sdk';
import { nanoid } from 'nanoid';
import { ClassmojiService, getGitProvider, GitHubProvider } from '@classmoji/services';
import { requireClassroomAdmin, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import { useDisclosure, useGlobalFetcher } from '~/hooks';
import type { Route } from './+types/route';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { class: classSlug } = params;

  await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'REPOSITORIES',
    action: 'view_module_update',
  });

  const url = new URL(request.url);
  const repositoryId = url.searchParams.get('id');
  const repository = await ClassmojiService.repository.findById(repositoryId!);
  return { repository };
};

const UpdateRepositories = ({ loaderData }: Route.ComponentProps) => {
  const { show, visible, close } = useDisclosure();
  const { repository } = loaderData;
  const navigate = useNavigate();
  const [form] = Form.useForm();
  const { fetcher } = useGlobalFetcher();
  const { class: classSlug } = useParams();

  useEffect(() => {
    show();
  }, []);

  // Leave only once the update has round-tripped: closing on the same tick as
  // submit() unmounted this route and cancelled the request. The fetcher can
  // still read idle right after submit(), so wait for idle→busy→idle.
  const [submitting, setSubmitting] = useState(false);
  const sawBusyRef = useRef(false);
  useEffect(() => {
    if (!submitting) return;
    if (fetcher!.state !== 'idle') {
      sawBusyRef.current = true;
      return;
    }
    if (!sawBusyRef.current) return;
    sawBusyRef.current = false;
    setSubmitting(false);
    close();
    navigate(-1);
  }, [submitting, fetcher!.state, close, navigate]);

  const onSubmit = () => {
    form
      .validateFields()
      .then(() => {
        const values = form.getFieldsValue();
        setSubmitting(true);
        fetcher!.submit(JSON.stringify({ values, repository }), {
          method: 'post',
          action: `/admin/${classSlug}/repos/update`,
          encType: 'application/json',
        });
      })
      .catch(errorInfo => {
        console.error('Validation Failed:', errorInfo);
      });
  };

  return (
    <Modal
      open={visible}
      onCancel={() => {
        close();
        navigate(-1);
      }}
      onOk={onSubmit}
      okText="Update"
    >
      <Form layout="vertical" form={form}>
        <h2 className="font-bold text-lg">Update repositories</h2>
        <Alert
          description="Make sure to push your changes to the template repository before running this."
          type="warning"
          className="my-4"
        />
        <Form.Item
          label="Pull request title"
          name="title"
          required
          rules={[{ required: true, message: 'Title is required' }]}
        >
          <Input />
        </Form.Item>
        <Form.Item label="Pull request description" name="description">
          <Input.TextArea rows={6} />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export const action = async ({ request, params }: Route.ActionArgs) => {
  const { class: classSlug } = params;

  const { classroom, membership } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'REPOSITORIES',
    action: 'update_repository',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });
  // Pushes template updates with the Github API; no GitLab path yet.
  if (isGitLabClassroom(classroom)) return { error: GITLAB_UNSUPPORTED };

  const { values, repository } = await request.json();
  const sessionId = nanoid();
  const accessToken = await auth.createPublicToken({
    scopes: {
      read: {
        tags: [`session_${sessionId}`],
      },
    },
  });

  // Use git_organization.login for GitHub API calls, not the classroom slug
  const gitOrgLogin = classroom.git_organization?.login;
  if (!gitOrgLogin) {
    throw new Response('Git organization not configured', { status: 400 });
  }

  const gitProvider = getGitProvider(classroom.git_organization);
  const octokit = await (gitProvider as GitHubProvider).getOctokit();

  const { data } = await octokit.request(
    'POST /app/installations/{installation_id}/access_tokens',
    {
      installation_id: Number(classroom.git_organization.github_installation_id),
      permissions: {
        contents: 'write',
        pull_requests: 'write',
      },
    }
  );

  const repositories = await ClassmojiService.gitRepo.findByRepository(classSlug!, repository.id);
  const [templateOwner, templateRepo] = repository.template.split('/');

  const payloads = repositories.map(repo => {
    return {
      payload: {
        gitOrganization: classroom.git_organization,
        repoName: repo.name,
        branchName: values.branchName,
        prTitle: values.title,
        prDescription: values.description,
        templateOwner,
        templateRepo,
        token: data.token,
      },
      options: { tags: [`session_${sessionId}`] },
    };
  });

  await tasks.batchTrigger('update_git_repo', payloads);

  return {
    triggerSession: {
      accessToken,
      id: sessionId,
      numReposToUpdate: payloads.length,
    },
  };
};

export default UpdateRepositories;
