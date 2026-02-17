import prisma from '@classmoji/database';
import { getTermCode } from '../git/index.js';

/**
 * Whitelist of setting fields that are SAFE to expose to the client.
 * NEVER add secret fields (API keys, tokens, etc.) to this list.
 */
const SAFE_SETTINGS_FIELDS = [
  'llm_model',
  'llm_provider',
  'llm_temperature',
  'llm_max_tokens',
  'code_aware_model',
  'syllabus_bot_enabled',
  'syllabus_bot_model',
  'content_repo_name',
  'slides_enabled',
  'quizzes_enabled',
  'default_tokens_per_hour',
  'late_penalty_points_per_hour',
  'show_grades_to_students',
  'default_student_page',
  'recent_viewers_enabled',
];

/**
 * Find a Classroom by its UUID
 * @param {string} id - UUID of the Classroom
 * @returns {Promise<Object|null>}
 */
export const findById = async id => {
  return prisma.classroom.findUnique({
    where: { id },
    include: {
      git_organization: true,
      settings: true,
      tags: true,
    },
  });
};

/**
 * Find a Classroom by its unique slug
 * @param {string} slug - URL-friendly slug (e.g., "cs101-fall-2025")
 * @returns {Promise<Object|null>}
 */
export const findBySlug = async slug => {
  return prisma.classroom.findUnique({
    where: { slug },
    include: {
      git_organization: true,
      settings: true,
      tags: true,
    },
  });
};

/**
 * Find all Classrooms for a GitOrganization
 * @param {string} gitOrgId - UUID of the GitOrganization
 * @returns {Promise<Object[]>}
 */
export const findByGitOrgId = async gitOrgId => {
  return prisma.classroom.findMany({
    where: { git_org_id: gitOrgId },
    include: {
      settings: true,
      tags: true,
    },
    orderBy: { created_at: 'desc' },
  });
};

/**
 * Find all Classrooms where a user is a member
 * @param {string} userId - UUID of the User
 * @param {string} [role] - Optional role filter
 * @returns {Promise<Object[]>}
 */
export const findByUserId = async (userId, role = null) => {
  const where = { user_id: userId };
  if (role) where.role = role;

  const memberships = await prisma.classroomMembership.findMany({
    where,
    include: {
      classroom: {
        include: {
          git_organization: true,
          settings: true,
        },
      },
    },
    orderBy: { created_at: 'desc' },
  });

  return memberships.map(m => ({
    ...m.classroom,
    membership: {
      role: m.role,
      is_grader: m.is_grader,
      has_accepted_invite: m.has_accepted_invite,
    },
  }));
};

/**
 * Find all active Classrooms
 * @param {Object} query - Optional where clause
 * @returns {Promise<Object[]>}
 */
export const findAll = async (query = {}) => {
  return prisma.classroom.findMany({
    where: { is_active: true, ...query },
    include: {
      git_organization: true,
      settings: true,
    },
    orderBy: { created_at: 'desc' },
  });
};

/**
 * Create a new Classroom
 * @param {Object} data - Classroom data
 * @param {string} data.git_org_id - UUID of the GitOrganization
 * @param {string} data.slug - URL-friendly slug
 * @param {string} data.name - Display name
 * @param {string} [data.term] - Term (FALL, SPRING, SUMMER, WINTER)
 * @param {number} [data.year] - Year
 * @param {string} [data.emoji] - Emoji (default: "dart")
 * @returns {Promise<Object>}
 */
export const create = async data => {
  return prisma.classroom.create({
    data,
    include: {
      git_organization: true,
      settings: true,
    },
  });
};

/**
 * Create a Classroom with its settings in a transaction
 * @param {Object} classroomData - Classroom data
 * @param {Object} settingsData - ClassroomSettings data (without classroom_id)
 * @returns {Promise<Object>}
 */
export const createWithSettings = async (classroomData, settingsData = {}) => {
  return prisma.$transaction(async tx => {
    const classroom = await tx.classroom.create({
      data: classroomData,
    });

    await tx.classroomSettings.create({
      data: {
        classroom_id: classroom.id,
        ...settingsData,
      },
    });

    return tx.classroom.findUnique({
      where: { id: classroom.id },
      include: {
        git_organization: true,
        settings: true,
      },
    });
  });
};

/**
 * Update a Classroom
 * @param {string} id - UUID of the Classroom
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>}
 */
export const update = async (id, updates) => {
  return prisma.classroom.update({
    where: { id },
    data: updates,
    include: {
      git_organization: true,
      settings: true,
    },
  });
};

/**
 * Update a Classroom by slug
 * @param {string} slug - Classroom slug
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>}
 */
export const updateBySlug = async (slug, updates) => {
  return prisma.classroom.update({
    where: { slug },
    data: updates,
    include: {
      git_organization: true,
      settings: true,
    },
  });
};

/**
 * Delete a Classroom by ID
 * @param {string} id - UUID of the Classroom
 * @returns {Promise<Object>}
 */
export const deleteById = async id => {
  return prisma.classroom.delete({
    where: { id },
  });
};

/**
 * Delete a Classroom by slug
 * @param {string} slug - Classroom slug
 * @returns {Promise<Object>}
 */
export const deleteBySlug = async slug => {
  return prisma.classroom.delete({
    where: { slug },
  });
};

/**
 * Count Classrooms in a GitOrganization
 * @param {string} gitOrgId - UUID of the GitOrganization
 * @returns {Promise<number>}
 */
export const countByGitOrg = async gitOrgId => {
  return prisma.classroom.count({
    where: { git_org_id: gitOrgId },
  });
};

/**
 * Get Classroom with settings SAFE for client consumption.
 * This sanitizes settings to remove API keys and other secrets.
 * NEVER use this for server-side operations that need API keys.
 *
 * @param {Object} classroom - Classroom object (with settings included)
 * @returns {Object} - Classroom with sanitized settings
 */
export const getClassroomForUI = classroom => {
  if (!classroom) return null;

  const { settings, ...safeClassroom } = classroom;

  if (!settings) {
    return { ...safeClassroom, settings: null };
  }

  // Only include whitelisted fields in settings
  const safeSettings = {};
  for (const field of SAFE_SETTINGS_FIELDS) {
    if (settings[field] !== undefined) {
      safeSettings[field] = settings[field];
    }
  }

  // Add computed flags for UI
  safeSettings.has_anthropic_key = Boolean(settings.anthropic_api_key);
  safeSettings.has_openai_key = Boolean(settings.openai_api_key);

  return {
    ...safeClassroom,
    settings: safeSettings,
  };
};

/**
 * Get API key for server-side use only.
 * Call this from actions/loaders for LLM operations.
 * NEVER return this result to the client!
 *
 * @param {string} classroomId - Classroom UUID
 * @returns {Promise<string|null>} - API key or null if not set
 */
export const getClassroomApiKey = async classroomId => {
  const settings = await prisma.classroomSettings.findUnique({
    where: { classroom_id: classroomId },
    select: { anthropic_api_key: true, openai_api_key: true },
  });
  return settings?.anthropic_api_key || settings?.openai_api_key || null;
};

/**
 * Get full Classroom settings for server-side operations.
 * Use this when you need access to API keys for LLM calls.
 * NEVER return this result to the client!
 *
 * @param {string} classroomId - Classroom UUID
 * @returns {Promise<Object|null>} - Full settings object including secrets
 */
export const getClassroomSettingsForServer = async classroomId => {
  return prisma.classroomSettings.findUnique({
    where: { classroom_id: classroomId },
  });
};

/**
 * Update Classroom settings
 * @param {string} classroomId - Classroom UUID
 * @param {Object} updates - Settings to update
 * @returns {Promise<Object>}
 */
export const updateSettings = async (classroomId, updates) => {
  return prisma.classroomSettings.upsert({
    where: { classroom_id: classroomId },
    create: {
      classroom_id: classroomId,
      ...updates,
    },
    update: updates,
  });
};

/**
 * Generate a unique slug for a classroom
 * @param {string} name - Classroom name
 * @param {string} term - Term (WINTER, SPRING, SUMMER, FALL) - required
 * @param {number} year - Year - required
 * @returns {Promise<string>}
 */
export const generateSlug = async (name, term, year) => {
  // Start with base slug from name
  let baseSlug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  // Add short term code (e.g., "25w" for Winter 2025)
  const termCode = getTermCode(term, year);
  baseSlug = `${baseSlug}-${termCode}`;

  // Check if slug exists
  let slug = baseSlug;
  let counter = 1;

  while (await prisma.classroom.findUnique({ where: { slug } })) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }

  return slug;
};
