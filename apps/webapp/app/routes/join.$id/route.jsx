import { redirect, useFetcher, useLoaderData } from 'react-router';
import { Button, Input, Form, Alert, Card } from 'antd';

import { getAuthSession } from '@classmoji/auth/server';
import { ClassmojiService } from '@classmoji/services';
import { Logo } from '@classmoji/ui-components';
import prisma from '@classmoji/database';

export const loader = async ({ request, params }) => {
  const authData = await getAuthSession(request);
  const { id } = params;

  // Not logged in — send to login, which will redirect back after OAuth
  if (!authData?.userId) return redirect('/');

  // Logged in but not registered yet (no email) — go through registration first
  const user = await ClassmojiService.user.findById(authData.userId);
  if (!user?.email) return redirect(`/registration?next=/join/${id}`);

  // Find the classroom
  const classroom = await prisma.classroom.findUnique({
    where: { id },
  });
  if (!classroom) throw new Response('Classroom not found', { status: 404 });

  // Already a member — redirect to classroom
  const existing = await ClassmojiService.classroomMembership.findByClassroomAndUser(
    classroom.id,
    user.id
  );
  if (existing) {
    const rolePrefix = existing.role === 'STUDENT' ? 'student' : 'admin';
    return redirect(`/${rolePrefix}/${classroom.slug}`);
  }

  // Check if user is on the roster for this classroom
  const invite = await ClassmojiService.classroomInvite.findInviteByClassroomAndEmail(
    classroom.id,
    user.email
  );

  return {
    classroom: { id: classroom.id, name: classroom.name },
    autoEnroll: !!invite,
    studentId: invite?.student_id ?? null,
  };
};

export const action = async ({ request, params }) => {
  const authData = await getAuthSession(request);
  if (!authData?.userId) return redirect('/');

  const { id } = params;
  const { studentId } = await request.json();

  const user = await ClassmojiService.user.findById(authData.userId);
  if (!user?.email) return redirect('/registration');

  const classroom = await prisma.classroom.findUnique({ where: { id } });
  if (!classroom) return { error: 'Classroom not found.' };

  // Guard against duplicate membership
  const existing = await ClassmojiService.classroomMembership.findByClassroomAndUser(
    classroom.id,
    user.id
  );
  if (existing) return { error: 'You are already a member of this classroom.' };

  // Check roster invite
  const invite = await ClassmojiService.classroomInvite.findInviteByClassroomAndEmail(
    classroom.id,
    user.email
  );

  const resolvedStudentId = invite?.student_id ?? studentId;

  if (!resolvedStudentId) {
    return { error: 'Please enter your student ID to join.' };
  }

  // Store student_id on user if not already set
  if (!user.student_id) {
    await prisma.user.update({
      where: { id: user.id },
      data: { student_id: resolvedStudentId },
    });
  }

  await ClassmojiService.classroomMembership.create({
    classroom_id: classroom.id,
    user_id: user.id,
    role: 'STUDENT',
    has_accepted_invite: false,
  });

  if (invite) {
    await ClassmojiService.classroomInvite.deleteInvite(invite.id);
  }

  return redirect('/select-organization');
};

export default function JoinClassroom() {
  const { classroom, autoEnroll, studentId } = useLoaderData();
  const fetcher = useFetcher();

  const isSubmitting = ['submitting', 'loading'].includes(fetcher.state);
  const error = fetcher.data?.error;

  const handleJoin = values => {
    fetcher.submit({ studentId: values?.studentId ?? studentId }, {
      method: 'POST',
      encType: 'application/json',
    });
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <div className="flex justify-center mb-4">
            <Logo size={48} />
          </div>
          <h1 className="text-2xl font-bold mb-2 dark:text-white">Join a Classroom</h1>
          <p className="text-gray-600 dark:text-gray-400 text-sm">
            You have been invited to <strong>{classroom.name}</strong>
          </p>
        </div>

        <Card
          className="shadow-xs border border-gray-200 dark:border-gray-700 dark:bg-gray-800"
          styles={{ body: { padding: '24px' } }}
        >
          {error && <Alert message={error} type="error" showIcon className="mb-4" />}

          {autoEnroll ? (
            <div className="text-center">
              <p className="text-gray-600 dark:text-gray-300 mb-6 text-sm">
                Your email matches an existing invite. Click below to join.
              </p>
              <Button
                type="primary"
                className="w-full h-10 text-sm font-medium !text-white"
                loading={isSubmitting}
                onClick={() => handleJoin({})}
              >
                {isSubmitting ? 'Joining...' : `Join ${classroom.name}`}
              </Button>
            </div>
          ) : (
            <Form layout="vertical" onFinish={handleJoin} disabled={isSubmitting}>
              <Form.Item
                label={<span className="font-medium text-gray-700 dark:text-gray-300 text-sm">Student ID</span>}
                name="studentId"
                rules={[{ required: true, message: 'Please enter your student ID' }]}
                className="mb-6"
              >
                <Input placeholder="Enter your student ID" />
              </Form.Item>
              <Button
                type="primary"
                htmlType="submit"
                className="w-full h-10 text-sm font-medium !text-white"
                loading={isSubmitting}
              >
                {isSubmitting ? 'Joining...' : `Join ${classroom.name}`}
              </Button>
            </Form>
          )}
        </Card>
      </div>
    </div>
  );
}
