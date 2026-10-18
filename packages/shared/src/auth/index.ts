/**
 * Authentication Module Exports
 */

// Phone + OTP Authentication
export {
  validatePhoneNumber,
  normalizePhone,
  sendOtp,
  verifyOtpAndAuthenticate,
  type PhoneAuthResult,
} from './phone';

// Session management
export {
  SESSION_CONFIG,
  SESSION_REDIS_KEYS,
  generateSessionToken,
  createSession,
  getSession,
  refreshSession,
  deleteSession,
  deleteAllUserSessions,
  getUserSessions,
  cleanupExpiredSessions,
  type SessionInfo,
  type CreateSessionOptions,
} from './session';
