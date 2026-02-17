import crypto from 'crypto';
import { ClassmojiService } from '@classmoji/services';

const CALENDAR_SECRET = process.env.CALENDAR_SECRET;

/**
 * Generate HMAC signature for a classroom slug
 */
function generateSignature(slug) {
  if (!CALENDAR_SECRET) {
    throw new Error('CALENDAR_SECRET environment variable is not set');
  }
  return crypto.createHmac('sha256', CALENDAR_SECRET).update(slug).digest('hex').slice(0, 16);
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
function secureCompare(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export const loader = async ({ params }) => {
  const { slug, signature } = params;

  // Verify signature
  try {
    const expected = generateSignature(slug);
    if (!secureCompare(signature, expected)) {
      return new Response('Not found', { status: 404 });
    }
  } catch (error) {
    console.error('Calendar signature verification error:', error);
    return new Response('Not found', { status: 404 });
  }

  // Find classroom by slug
  const classroom = await ClassmojiService.classroom.findBySlug(slug);
  if (!classroom) {
    return new Response('Not found', { status: 404 });
  }

  // Generate ICS content
  try {
    const icsContent = await ClassmojiService.icsGenerator.generateCalendarFeed(
      classroom.id,
      classroom.slug
    );

    return new Response(icsContent, {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="${slug}-calendar.ics"`,
        'Cache-Control': 'no-cache, must-revalidate',
      },
    });
  } catch (error) {
    console.error('Error generating calendar feed:', error);
    return new Response('Internal server error', { status: 500 });
  }
};
