import { Modal, Form, Input, Alert } from 'antd';
import { isGitLabClassroom } from '~/utils/gitlabGuard.server';
import { repoNamespace, resolveTemplateRef } from '@classmoji/utils';
import { useNavigate, useParams } from 'react-router';
import { useEffect } from 'react';
import { auth, tasks } from '@trigger.dev/sdk';
import { nanoid } from 'nanoid';
import { ClassmojiService, getGitProvider, GitHubProvider } from '@classmoji/services';
import { requireClassroomAdmin, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import { useDisclosure, useGlobalFetcher } from '~/hooks';
import { useGitWeb } from '~/hooks/useGitWeb';
import { parseUpdateRequest } from '../admin.$class.repos.update/updateRequest.server';
import type { Route } from './+types/route';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { class: classSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'REPOSITORIES',
    action: 'view_module_update',
  });

  const url = new URL(request.url);
  const repositoryId = url.searchParams.get('id');
  const repository = await ClassmojiService.repository.findByIdInClassroom(
    repositoryId,
    classroom.id
  );
  if (!repository) throw new Response('Repository not found', { status: 404 });
  return { repository };
};

const UpdateRepositories = ({ loaderData }: Route.ComponentProps) => {
  const { show, visible, close } = useDisclosure();
  const { repository } = loaderData;
  const navigate = useNavigate();
  const [form] = Form.useForm();
  const { terms } = useGitWeb();
  const { fetcher } = useGlobalFetcher();
  const { class: classSlug, title } = useParams();

  useEffect(() => {
    show();
  }, []);

  const onSubmit = () => {
    form
      .validateFields()
      .then(() => {
        const values = form.getFieldsValue();
        fetcher!.submit(JSON.stringify({ values, repository: { id: repository.id } }), {
          method: 'post',
          action: `/admin/${classSlug}/repos/${title}/update`,
          encType: 'application/json',
        });

        close();
        navigate(-1);
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
        <h2 className="font-bold text-lg">Update {terms.repos}</h2>
        <Alert
          description={`Make sure to push your changes to the template ${terms.repo} before running this.`}
          type="warning"
          className="my-4"
        />
        <Form.Item
          label={`${terms.PR} title`}
          name="title"
          required
          rules={[{ required: true, message: 'Title is required' }]}
        >
          <Input />
        </Form.Item>
        <Form.Item label={`${terms.PR} description`} name="description">
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

  const parsed = await parseUpdateRequest(request);
  if (!parsed) return { error: 'Invalid request.' };
  const { values } = parsed;

  // The body names the repository by id only; it is loaded from this classroom,
  // and the template the student repos are updated from is the stored one. A
  // bare template name is a repository in the classroom's own organization.
  const repository = await ClassmojiService.repository.findByIdInClassroom(
    parsed.repositoryId,
    classroom.id
  );
  if (!repository) return { error: 'Repository not found.' };
  const templateRef = resolveTemplateRef(repository.template, classroom.git_organization?.login);
  if (!templateRef) {
    return {
      error: isGitLabClassroom(classroom)
        ? 'This project has no template project to update from.'
        : 'This repository has no template repository to update from.',
    };
  }

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
    throw new Response('Github organization not configured', { status: 400 });
  }

  // Github: a short-lived installation token the task clones and pushes with.
  // GitLab: the task mints its own from the org's connection (they rotate).
  let token = '';
  if (!isGitLabClassroom(classroom)) {
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
    token = data.token;
  }

  const repositories = await ClassmojiService.gitRepo.findByRepository(classSlug!, repository.id);
  const { owner: templateOwner, repo: templateRepo } = templateRef;

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
        token,
        // GitLab: student projects live in the class subgroup's `projects`.
        repoOwner: classroom.git_namespace ? repoNamespace(classroom) : null,
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
