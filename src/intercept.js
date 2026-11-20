/**
 * intercept.js — Response listener + endpoint router
 *
 * Registers network response handlers for TikTok API endpoints.
 * Routes each intercepted response to the appropriate normalizer.
 */

import { normalizeSearchItem, normalizeSearchGeneral } from './normalize/searchItem.js';
import { normalizeChallengeItem } from './normalize/challengeItem.js';
import { normalizeCommentList, normalizeCommentReplyList } from './normalize/comment.js';
import { normalizeVideoItem } from './normalize/shared.js';

// API endpoint path matchers
export const ENDPOINTS = {
  SEARCH_GENERAL: '/api/search/general/full/',
  SEARCH_ITEM: '/api/search/item/full/',
  CHALLENGE_ITEM: '/api/challenge/item_list/',
  POST_ITEM_LIST: '/api/post/item_list/',
  COMMENT_REPLY_LIST: '/api/comment/list/reply/',
  COMMENT_LIST: '/api/comment/list/',
  ITEM_DETAIL: '/api/item/detail/',
  USER_DETAIL: '/api/user/detail/',
};

// TikTok API status codes
export const STATUS_CODES = {
  OK: 0,
  CAPTCHA: 10000,
  RATE_LIMIT: 10101,
  LOGIN_REQUIRED: 22000,
};

export class CaptchaError extends Error {
  constructor(statusCode, message = 'Captcha/Signature required') {
    super(message);
    this.name = 'CaptchaError';
    this.statusCode = statusCode;
  }
}

export class RateLimitError extends Error {
  constructor(message = 'Rate limited') {
    super(message);
    this.name = 'RateLimitError';
  }
}

/**
 * Extract a query param safely from a URL string.
 */
function getQueryParam(url, param) {
  try {
    return new URL(url).searchParams.get(param);
  } catch {
    return null;
  }
}

/**
 * Register response interception handlers on a Playwright page.
 * Returns a `cleanup()` function to detach the listener when done.
 */
export function setupInterceptors(page, options = {}) {
  const {
    onItem = () => {},
    onRaw = () => {},
    onError = () => {},
    endpoints = Object.values(ENDPOINTS),
    dedupSet = null,
  } = options;

  const seenIds = dedupSet || new Set();
  // Match longest/most-specific path first so `/api/comment/list/reply/`
  // is never swallowed by `/api/comment/list/`.
  const sortedEndpoints = [...endpoints].sort((a, b) => b.length - a.length);

  const handler = async (res) => {
    const url = res.url();

    // Check if this response matches any endpoint we care about
    const matchedEndpoint = sortedEndpoints.find((t) => url.includes(t));
    if (!matchedEndpoint) return;

    // Only process successful responses
    if (res.status() !== 200) return;

    try {
      const json = await res.json();

      // Check for error status codes
      if (json.status_code && json.status_code !== STATUS_CODES.OK) {
        if (json.status_code === STATUS_CODES.CAPTCHA) {
          onError(new CaptchaError(json.status_code));
          return;
        }
        if (json.status_code === STATUS_CODES.RATE_LIMIT) {
          onError(new RateLimitError());
          return;
        }
        // Other status codes - log and continue
        onError(new Error(`API error: ${json.status_code}`));
        return;
      }

      // Route to appropriate normalizer
      const normalized = normalizeResponse(json, matchedEndpoint, seenIds, url);

      if (normalized && normalized.length > 0) {
        for (const item of normalized) {
          onItem(item);
        }
      }

      // Always emit raw for downstream processing
      onRaw({
        endpoint: matchedEndpoint,
        url,
        data: json,
        itemCount: normalized?.length || 0,
        hasMore: Boolean(json.hasMore ?? json.has_more ?? false),
        cursor: json.cursor ?? json.minCursor ?? null,
      });
    } catch {
      // Non-JSON response or parse error - skip silently
    }
  };

  page.on('response', handler);

  return {
    ENDPOINTS,
    STATUS_CODES,
    cleanup: () => {
      if (typeof page.off === 'function') {
        page.off('response', handler);
      } else if (typeof page.removeListener === 'function') {
        page.removeListener('response', handler);
      }
    },
  };
}

/**
 * Route a response to the correct normalizer based on endpoint
 */
function normalizeResponse(data, endpoint, seenIds, url = '') {
  switch (endpoint) {
    case ENDPOINTS.SEARCH_GENERAL:
      return normalizeSearchGeneral(data, seenIds);
    case ENDPOINTS.SEARCH_ITEM:
      return normalizeSearchItem(data, seenIds);
    case ENDPOINTS.CHALLENGE_ITEM:
      return normalizeChallengeItem(data, seenIds);
    case ENDPOINTS.POST_ITEM_LIST:
      return normalizeSearchItem(data, seenIds); // Same structure as search
    case ENDPOINTS.COMMENT_REPLY_LIST:
      return normalizeCommentReplyList(data, seenIds, getQueryParam(url, 'comment_id'));
    case ENDPOINTS.COMMENT_LIST:
      return normalizeCommentList(data, seenIds);
    case ENDPOINTS.ITEM_DETAIL: {
      const itemStruct = data?.itemInfo?.itemStruct;
      if (!itemStruct) return [];
      const normalized = normalizeVideoItem(itemStruct);
      return normalized ? [{ ...normalized, _type: 'video_detail' }] : [];
    }
    default:
      return [];
  }
}
