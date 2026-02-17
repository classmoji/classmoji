import { Modal, Form, Input, Alert } from 'antd';
import { useNavigate, useParams } from 'react-router';
import { useEffect } from 'react';
import { auth, tasks } from '@trigger.dev/sdk';
import { nanoid } from 'nanoid';
import { ClassmojiService } from '@classmoji/services';
import { getGitProvider } from '@classmoji/services';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import { useDisclosure, useGlobalFetcher } from '~/hooks';

export const loader = async ({ request, params }) => {
  const { class: classSlug } = params;

  await requireClassroomAdmin(request, classSlug, {
    resourceType: 'MODULES',
    action: 'view_module_update',
  });

  const url = new URL(request.url);
  const moduleId = url.searchParams.get('id');
  const module = await ClassmojiService.module.findById(moduleId);
  return { module };
};

const UpdateRepositories = ({ loaderData }) => {
  const { show, visible, close } = useDisclosure();
  const { module } = loaderData;
  const navigate = useNavigate();
  const [form] = Form.useForm();
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
        fetcher.submit(
          { values, module },
          {
            method: 'post',
            action: `/admin/${classSlug}/modules/${title}/update`,
            encType: 'application/json',
          }
        );

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

export const action = async ({ request, params }) => {
  const { class: classSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'MODULES',
    action: 'update_module',
  });

  const { values, module } = await request.json();
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
  const octokit = await gitProvider.getOctokit();

  const { data } = await octokit.request('POST /app/installations/{installation_id}/access_tokens', {
    installation_id: classroom.git_organization.github_installation_id,
    permissions: {
      contents: 'write',
      pull_requests: 'write',
    },
  });

  const repositories = await ClassmojiService.repository.findByModule(classSlug, module.id);
  const [templateOwner, templateRepo] = module.template.split('/');

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

  await tasks.batchTrigger('update_repository', payloads);

  return {
    triggerSession: {
      accessToken,
      id: sessionId,
      numReposToUpdate: payloads.length,
    },
  };
};

export default UpdateRepositories;
