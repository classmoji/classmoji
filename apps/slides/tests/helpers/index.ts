/**
 * Test helpers for Slides E2E tests
 *
 * Re-exports all helper functions for convenient importing:
 * import { loginAs, createSlide, waitForReveal } from './helpers';
 */

// Authentication helpers
export {
  loginAs,
  logout,
  isLoggedIn,
  getSessionToken,
  type TestRole,
} from './auth.helpers';

// Environment helpers
export {
  getDevPort,
  getSlidesBaseURL,
  getTestClassroomSlug,
  getTestClassroomOrg,
  getTestClassroomTerm,
} from './env.helpers';

// Wait helpers
export {
  waitForPageLoad,
  waitForReveal,
  waitForToast,
  waitForNavigation,
  waitForSave,
  retry,
} from './wait.helpers';

// Slide helpers
export {
  createSlide,
  viewSlide,
  editSlide,
  presentSlide,
  speakerView,
  followSlide,
  saveSlide,
  toggleEditMode,
  addTextBlock,
  addHeading,
  addCodeBlock,
  addSlideRight,
  addSlideBelow,
  openNotesPanel,
  addSpeakerNotes,
  getSpeakerNotes,
  deleteSlide,
  isEditButtonVisible,
  isPresentButtonVisible,
  areNotesVisible,
  pageContainsText,
  setSlideVisibility,
  publishSlide,
  getCurrentSlideNumber,
  goToSlide,
  countSlides,
  type SlideVisibility,
} from './slides.helpers';
