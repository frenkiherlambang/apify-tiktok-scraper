/**
 * antibot.js — Captcha detection, backoff, and session retirement
 *
 * Detects TikTok anti-bot measures and implements recovery strategies:
 * - Captcha detection (status_code 10000)
 * - Rate limit detection (status_code 10101)
 * - Exponential backoff
 * - Session retirement after failures
 */

import { CaptchaError, RateLimitError } from './intercept.js';

// Error types that indicate a blocked session
const BLOCKED_ERRORS = ['CaptchaError', 'RateLimitError', 'LoginRequiredError'];

/**
 * Check if an error indicates the session is blocked
 */
export function isBlockedError(error) {
  return BLOCKED_ERRORS.includes(error.name) ||
    error.message?.includes('captcha') ||
    error.message?.includes('rate limit') ||
    error.message?.includes('login');
}

/**
 * Check if error is a captcha challenge
 */
export function isCaptchaError(error) {
  return error instanceof CaptchaError || error.statusCode === 10000;
}

/**
 * Check if error is rate limiting
 */
export function isRateLimitError(error) {
  return error instanceof RateLimitError || error.statusCode === 10101;
}

/**
 * Calculate backoff delay with exponential backoff and jitter
 */
export function getBackoffDelay(attempt, baseDelay = 1000, maxDelay = 60000) {
  const exponentialDelay = baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * baseDelay;
  return Math.min(exponentialDelay + jitter, maxDelay);
}

/**
 * Sleep for a given duration
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Detect if the page is showing a captcha challenge
 */
export async function detectCaptcha(page) {
  const captchaIndicators = [
    'captcha_container',
    'captcha-verify',
    'tiktok-captcha',
    '#captcha',
    '.captcha',
  ];

  for (const selector of captchaIndicators) {
    const element = await page.$(selector);
    if (element) return true;
  }

  // Check for captcha in page content
  const pageContent = await page.content();
  const captchaPatterns = [
    'captcha',
    'verify',
    'challenge',
    'Please verify',
  ];

  const lowerContent = pageContent.toLowerCase();
  return captchaPatterns.some((pattern) => lowerContent.includes(pattern.toLowerCase()));
}

/**
 * Detect if we've been logged out
 */
export async function detectLoggedOut(page) {
  // Check for login button or "not logged in" indicators
  const loginButton = await page.$('[data-e2e="top-login-button"]');
  const avatar = await page.$('[data-e2e="profile-icon"]');
  return !!loginButton || !avatar;
}

/**
 * Session manager - handles session rotation and retirement
 */
export class SessionManager {
  constructor(sessions, options = {}) {
    this.sessions = sessions;
    this.currentIndex = 0;
    this.failedSessions = new Set();
    this.maxRetriesPerSession = options.maxRetriesPerSession || 3;
    this.retryCounts = new Map();
  }

  /**
   * Get the current active session
   */
  getCurrent() {
    return this.sessions[this.currentIndex];
  }

  /**
   * Rotate to the next available session
   */
  rotate() {
    // Find next non-failed session
    for (let i = 0; i < this.sessions.length; i++) {
      this.currentIndex = (this.currentIndex + 1) % this.sessions.length;
      if (!this.failedSessions.has(this.currentIndex)) {
        return this.getCurrent();
      }
    }
    return null; // All sessions failed
  }

  /**
   * Mark current session as failed
   */
  markFailed(reason = 'unknown') {
    this.failedSessions.add(this.currentIndex);
    return {
      sessionIndex: this.currentIndex,
      reason,
      remaining: this.getRemainingCount(),
    };
  }

  /**
   * Check if we have remaining sessions
   */
  hasRemaining() {
    return this.getRemainingCount() > 0;
  }

  /**
   * Get count of remaining sessions
   */
  getRemainingCount() {
    return this.sessions.length - this.failedSessions.size;
  }

  /**
   * Record a retry attempt for current session
   */
  recordRetry() {
    const current = this.retryCounts.get(this.currentIndex) || 0;
    this.retryCounts.set(this.currentIndex, current + 1);
    return current + 1;
  }

  /**
   * Check if current session has exceeded max retries
   */
  shouldRotate() {
    const retries = this.retryCounts.get(this.currentIndex) || 0;
    return retries >= this.maxRetriesPerSession;
  }
}

/**
 * Handle an error with appropriate strategy
 */
export async function handleError(error, context = {}) {
  const { sessionManager, page, attempt = 0, log = console } = context;

  if (isCaptchaError(error)) {
    log.warning(`Captcha detected: ${error.message}`);
    if (sessionManager) {
      sessionManager.markFailed('captcha');
      if (sessionManager.hasRemaining()) {
        const nextSession = sessionManager.rotate();
        log.info(`Rotating to session ${sessionManager.currentIndex}`);
        return { action: 'rotate', session: nextSession };
      }
    }
    return { action: 'abort', reason: 'captcha' };
  }

  if (isRateLimitError(error)) {
    log.warning(`Rate limited: ${error.message}`);
    const delay = getBackoffDelay(attempt);
    log.info(`Backing off for ${delay}ms`);
    await sleep(delay);
    return { action: 'retry', delay };
  }

  // Unknown error - retry with backoff
  log.error(`Unknown error: ${error.message}`);
  const delay = getBackoffDelay(attempt);
  await sleep(delay);
  return { action: 'retry', delay };
}

/**
 * Validate session health by checking if still logged in
 */
export async function validateSessionHealth(page) {
  try {
    // Navigate to a lightweight page that requires auth
    await page.goto('https://www.tiktok.com/foryou', {
      waitUntil: 'domcontentloaded',
      timeout: 10000,
    });

    await page.waitForTimeout(2000);

    const loggedOut = await detectLoggedOut(page);
    const captcha = await detectCaptcha(page);

    return {
      healthy: !loggedOut && !captcha,
      loggedOut,
      captcha,
    };
  } catch (error) {
    return {
      healthy: false,
      loggedOut: false,
      captcha: false,
      error: error.message,
    };
  }
}
