/**
 * Test API: Update Slide Visibility
 *
 * Development-only endpoint for E2E tests to update slide visibility.
 * POST /api/test/update-visibility
 * Body: { slideId, visibility: 'draft' | 'private' | 'public' }
 */

import prisma from '@classmoji/database';
import { requireAuth } from '@classmoji/auth/server';

export const action = async ({ request }) => {
  // Only available in development
  if (process.env.NODE_ENV !== 'development') {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Require authentication
  const session = await requireAuth(request);
  if (!session?.userId) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json();
    const { slideId, visibility, showSpeakerNotes, allowTeamEdit } = body;

    if (!slideId) {
      return new Response(JSON.stringify({ error: 'slideId is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const updateData = {};

    // Parse visibility setting
    if (visibility) {
      if (visibility === 'draft') {
        updateData.is_draft = true;
        updateData.is_public = false;
      } else if (visibility === 'private') {
        updateData.is_draft = false;
        updateData.is_public = false;
      } else if (visibility === 'public') {
        updateData.is_draft = false;
        updateData.is_public = true;
      }
    }

    // Parse boolean flags
    if (showSpeakerNotes !== undefined) {
      updateData.show_speaker_notes = showSpeakerNotes === true;
    }

    if (allowTeamEdit !== undefined) {
      updateData.allow_team_edit = allowTeamEdit === true;
    }

    if (Object.keys(updateData).length === 0) {
      return new Response(JSON.stringify({ error: 'No settings to update' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    await prisma.slide.update({
      where: { id: slideId },
      data: updateData,
    });

    return new Response(JSON.stringify({ success: true, ...updateData }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to update visibility:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
