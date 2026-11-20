/**
 * comments.js — Dedicated TikTok video page, comment, and nested reply scraper
 *
 * Uses network interception on /api/comment/list/, /api/comment/list/reply/, and
 * /api/item/detail/ paired with comment-drawer opening, container scrolling, and
 * UI click expansion so TikTok's own JS signs every paginated request.
 */

import { setupInterceptors, ENDPOINTS, CaptchaError, RateLimitError } from './intercept.js';
import { buildCommentTree } from './normalize/comment.js';
import { normalizeVideoItem } from './normalize/shared.js';
import { detectCaptcha } from './antibot.js';

const COMMENT_OPEN_SELECTORS = [
  '[data-e2e="comment-icon"]',
  '[data-e2e="browse-comment-icon"]',
  '[data-e2e="search-comment-tab"]',
];

const VIDEO_HYDRATION_SELECTOR = [
  '[data-e2e="comment-icon"]',
  '[data-e2e="browse-comment-icon"]',
  '[data-e2e="comment-level-1"]',
  '#captcha_container',
  '#captcha-verify',
  '[data-e2e="captcha-container"]',
].join(', ');

const MODAL_CLOSE_SELECTORS = [
  '[data-e2e="modal-close-inner-button"]',
  'button[aria-label="Close"]',
];

/**
 * Parse a direct video query (full URL, short URL, or bare numeric video ID).
 */
export function parseVideoQuery(raw) {
  const value = String(raw || '').trim();
  if (!value) {
    throw new Error('Empty video query');
  }

  // Bare numeric TikTok video ID
  if (/^\d{10,25}$/.test(value)) {
    return {
      url: `https://www.tiktok.com/video/${value}`,
      videoId: value,
      username: null,
    };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(value.startsWith('http') ? value : `https://${value}`);
  } catch {
    throw new Error(`Invalid TikTok video URL or ID: "${value}"`);
  }

  if (!/(^|\.)tiktok\.com$/i.test(parsedUrl.hostname)) {
    throw new Error(`Unsupported host for TikTok video URL: "${parsedUrl.hostname}"`);
  }

  const match = parsedUrl.pathname.match(/^\/@([^/]+)\/(?:video|photo)\/(\d+)/i);
  if (match) {
    return {
      url: parsedUrl.toString(),
      username: match[1],
      videoId: match[2],
    };
  }

  const bareMatch = parsedUrl.pathname.match(/\/(?:video|photo)\/(\d+)/i);
  return {
    url: parsedUrl.toString(),
    username: null,
    videoId: bareMatch ? bareMatch[1] : null,
  };
}

/**
 * Extract video itemStruct from TikTok's SSR rehydration JSON on a video page.
 */
export async function extractVideoFromPage(page) {
  try {
    const rawStruct = await page.evaluate(() => {
      const universalEl = document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__');
      if (universalEl?.textContent) {
        try {
          const parsed = JSON.parse(universalEl.textContent);
          const scope = parsed?.__DEFAULT_SCOPE__;
          const detail = scope?.['webapp.video-detail'] || scope?.['webapp.reflow.video.detail'];
          const itemStruct = detail?.itemInfo?.itemStruct;
          if (itemStruct?.id) return itemStruct;
        } catch {
          // Fall through to SIGI_STATE
        }
      }

      const sigiEl = document.querySelector('#SIGI_STATE');
      if (sigiEl?.textContent) {
        try {
          const parsed = JSON.parse(sigiEl.textContent);
          const itemModule = parsed?.ItemModule;
          if (itemModule && typeof itemModule === 'object') {
            const first = Object.values(itemModule)[0];
            if (first?.id) return first;
          }
        } catch {
          // Ignore parse errors
        }
      }

      return null;
    });

    return rawStruct ? normalizeVideoItem(rawStruct) : null;
  } catch {
    return null;
  }
}

/**
 * Build a minimal fallback video object when neither /api/item/detail/ nor SSR JSON was available.
 */
export function buildFallbackVideo(resolvedUrl, parsed = {}) {
  let info = parsed;
  try {
    if (resolvedUrl) {
      info = { ...parsed, ...parseVideoQuery(resolvedUrl) };
    }
  } catch {
    // Keep provided parsed info
  }

  const videoId = info.videoId || null;
  const username = info.username || null;

  return {
    post_id: videoId,
    shortcode: videoId,
    post_url: resolvedUrl || info.url || null,
    text: '',
    timestamp: null,
    user: {
      user_id: null,
      username,
      full_name: null,
      profile_url: username ? `https://www.tiktok.com/@${username}` : null,
      profile_pic_url: null,
      is_verified: false,
      follower_count: null,
    },
    likes: null,
    replies: null,
    reposts: null,
    quotes: null,
    reshares: null,
    views: null,
    saves: null,
    bookmarks: null,
    images: [],
    videos: [],
    is_reply: false,
    source: 'api',
    location_created: null,
    region: null,
  };
}

/**
 * Wait until `predicate()` turns truthy or `timeoutMs` elapses.
 */
async function waitUntil(page, predicate, timeoutMs, pollMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    const remaining = deadline - Date.now();
    await page.waitForTimeout(Math.min(pollMs, Math.max(20, remaining)));
  }
  return predicate();
}

/**
 * Scroll both TikTok's comment container(s) and the page window to trigger
 * the next /api/comment/list/ page.
 */
async function scrollCommentsDown(page) {
  await page.evaluate(() => {
    const selectors = [
      '[class*="DivCommentMain"]',
      '[data-e2e="comment-list"]',
      '[class*="DivCommentListContainer"]',
      '[class*="CommentListContainer"]',
      '[class*="DivCommentContainer"]',
      '[class*="DivScrollingContentContainer"]',
    ];

    const scrolled = new Set();
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.scrollHeight > el.clientHeight) {
          el.scrollTop = el.scrollHeight;
          scrolled.add(el);
        }
      }
    }

    // Walk up from the last rendered top-level comment to find its real scroll container
    const commentNodes = document.querySelectorAll(
      '[data-e2e="comment-level-1"], [class*="DivCommentItemContainer"], [class*="DivCommentObjectWrapper"]'
    );
    if (commentNodes.length > 0) {
      const lastNode = commentNodes[commentNodes.length - 1];
      lastNode.scrollIntoView({ behavior: 'instant', block: 'end' });
      let parent = lastNode.parentElement;
      while (parent && parent !== document.body) {
        if (parent.scrollHeight > parent.clientHeight + 20 && !scrolled.has(parent)) {
          const style = window.getComputedStyle(parent);
          if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
            parent.scrollTop = parent.scrollHeight;
            scrolled.add(parent);
          }
        }
        parent = parent.parentElement;
      }
    }

    // Always scroll window as fallback (standalone video pages scroll the document)
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
}

/**
 * Dismiss any non-blocking modal (e.g. guest login popup) if visible.
 */
async function dismissModals(page) {
  for (const selector of MODAL_CLOSE_SELECTORS) {
    try {
      const btn = await page.$(selector);
      if (btn && (await btn.isVisible?.())) {
        await btn.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(400);
      }
    } catch {
      // Ignore modal dismissal failures
    }
  }
}

/**
 * Click the comment drawer button on a TikTok video page if /api/comment/list/
 * did not fire automatically on page load.
 *
 * TikTok renders direct video URLs in a full-screen feed layout with multiple
 * [data-e2e="comment-icon"] nodes (current + next preloaded slide), so we scan
 * all matching handles and click the first visible one (with a JS click fallback).
 */
async function ensureCommentsOpen(page, isLoaded, { openTimeoutMs = 8000, log } = {}) {
  if (isLoaded()) return true;

  for (const selector of COMMENT_OPEN_SELECTORS) {
    try {
      const handles = typeof page.$$ === 'function'
        ? await page.$$(selector)
        : (await page.$(selector) ? [await page.$(selector)] : []);

      if (!handles || handles.length === 0) continue;

      let clicked = false;
      for (const el of handles) {
        if (!el) continue;
        const visible = typeof el.isVisible === 'function' ? await el.isVisible().catch(() => false) : true;
        if (!visible) continue;

        try {
          await el.click({ timeout: 3000 });
          clicked = true;
          break;
        } catch {
          // Try next visible handle or fall back to JS click below
        }
      }

      if (!clicked) {
        clicked = await page.evaluate((sel) => {
          const nodes = Array.from(document.querySelectorAll(sel));
          const target = nodes.find((n) => {
            const r = n.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.top >= 0 && r.top < window.innerHeight;
          }) || nodes[0];
          if (!target) return false;
          target.click();
          return true;
        }, selector).catch(() => false);
      }

      if (clicked) {
        log?.info?.(`Clicked ${selector} to open comment drawer`);
        const loaded = await waitUntil(page, isLoaded, openTimeoutMs);
        if (loaded) return true;
      }
    } catch {
      // Try next selector
    }
  }

  return isLoaded();
}

/**
 * Find the next visible "View replies" / "View more" button in the DOM and tag it
 * with a unique marker attribute so Playwright can click it as a trusted user event.
 *
 * Returns `{ markerId, commentText, label, isLoadMore }` or `null` if none are available.
 */
async function findNextReplyExpander(page, { allowedTexts, exhaustedTexts, nextMarkerId }) {
  return page.evaluate(
    ({ allowed, exhausted, markerId }) => {
      const HIDE_PATTERN = /^(hide|sembunyikan|tutup|collapse|ocultar|masquer|非表示|숨기기|ẩn)/i;
      // Match localized "View X replies" / "View more" / "Lihat X balasan" etc.
      // Intentionally excludes bare "Reply"/"Jawab" compose buttons.
      const VIEW_PATTERN = /(view\s+(\d+|more)|lihat\s+(\d+|lainnya|balasan)|tampilkan|ver\s+(\d+|más)|xem\s+(\d+|thêm)|ดู.*ตอบกลับ|返信を表示|답글\s*(\d+|더보기)|more\s+repl|balasan\s+lainnya)/i;

      const normalizeText = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const allowedSet = allowed ? new Set(allowed) : null;
      const exhaustedSet = new Set(exhausted || []);

      const isVisibleEl = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = window.getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
      };

      const findParentCommentText = (el) => {
        let cur = el.parentElement;
        for (let depth = 0; cur && depth < 10; depth += 1) {
          const level1 = cur.querySelector?.('[data-e2e="comment-level-1"]');
          if (level1) {
            return normalizeText(level1.textContent);
          }
          cur = cur.parentElement;
        }
        return null;
      };

      const primaryCandidates = Array.from(
        document.querySelectorAll('[data-e2e="view-more-1"], [data-e2e="view-more-2"]')
      );

      const fallbackCandidates = primaryCandidates.length > 0
        ? []
        : Array.from(
          document.querySelectorAll(
            '[class*="DivViewRepliesContainer"] button, [class*="DivViewMoreRepliesWrapper"] button, [class*="DivReplyContainer"] button, [class*="DivViewRepliesContainer"] p, [class*="DivViewRepliesContainer"] span, [class*="ReplyAction"] button, [class*="PViewMoreText"]'
          )
        );

      const candidates = [...primaryCandidates, ...fallbackCandidates];

      for (const el of candidates) {
        if (el.getAttribute('data-scraper-exhausted') === '1') continue;
        // Never click the compose "Reply" / "Jawab" button
        const e2e = el.getAttribute('data-e2e') || '';
        if (e2e.startsWith('comment-reply')) continue;
        if (!isVisibleEl(el)) continue;

        const label = normalizeText(el.textContent);
        if (!label || HIDE_PATTERN.test(label)) continue;

        const isPrimary = el.matches?.('[data-e2e="view-more-1"], [data-e2e="view-more-2"]');
        if (!isPrimary && !VIEW_PATTERN.test(label)) continue;

        const commentText = findParentCommentText(el);
        if (commentText && exhaustedSet.has(commentText)) {
          el.setAttribute('data-scraper-exhausted', '1');
          continue;
        }
        if (allowedSet && commentText && !allowedSet.has(commentText)) {
          // Belongs to a comment beyond commentsPerPost
          el.setAttribute('data-scraper-exhausted', '1');
          continue;
        }

        el.setAttribute('data-scraper-btn', markerId);
        return {
          markerId,
          commentText,
          label,
          isLoadMore: e2e === 'view-more-2' || /more|lainnya|más|thêm/i.test(label),
        };
      }

      return null;
    },
    { allowed: allowedTexts, exhausted: exhaustedTexts, markerId: nextMarkerId }
  );
}

/**
 * Mark a previously tagged expander button as exhausted so it won't be clicked again.
 */
async function markExpanderExhausted(page, markerId) {
  await page.evaluate((id) => {
    const el = document.querySelector(`[data-scraper-btn="${id}"]`);
    if (el) el.setAttribute('data-scraper-exhausted', '1');
  }, markerId).catch(() => {});
}

/**
 * Click "View replies" / "View more" buttons on rendered comments to trigger
 * TikTok's signed /api/comment/list/reply/ requests.
 */
async function expandCommentReplies(page, state, options) {
  const {
    commentsPerPost,
    repliesPerComment,
    replyClickDelay = 1200,
    replyResponseTimeout = 3500,
    maxConsecutiveReplyErrors = 3,
    log,
  } = options;

  const targetTop = state.topComments.slice(0, commentsPerPost);
  const parentsNeedingReplies = targetTop.filter((c) => (c.sub_comment_count || c.replies || 0) > 0);
  if (parentsNeedingReplies.length === 0) return;

  const normalizeText = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const textToParentIds = new Map();
  const allowedTexts = [];

  for (const comment of targetTop) {
    const key = normalizeText(comment.text);
    if (!key) continue;
    allowedTexts.push(key);
    if (!textToParentIds.has(key)) textToParentIds.set(key, []);
    textToParentIds.get(key).push(comment.comment_id);
  }

  const isParentSatisfied = (parentId) => {
    const count = state.replyCountByParent.get(parentId) || 0;
    if (count >= repliesPerComment) return true;
    if (state.replyHasMoreByParent.get(parentId) === false) return true;
    return false;
  };

  const getExhaustedTexts = () => {
    const exhausted = [];
    for (const [text, ids] of textToParentIds.entries()) {
      if (ids.every((id) => isParentSatisfied(id))) {
        exhausted.push(text);
      }
    }
    return exhausted;
  };

  // Global safety cap so a viral video cannot loop forever
  const maxClicksPerParent = Math.max(2, Math.ceil(repliesPerComment / 3) + 2);
  const maxTotalClicks = Math.min(250, parentsNeedingReplies.length * maxClicksPerParent);
  const clicksByCommentText = new Map();
  let totalClicks = 0;

  while (totalClicks < maxTotalClicks) {
    if (state.fatalError) break;
    if (state.consecutiveReplyErrors >= maxConsecutiveReplyErrors) {
      log?.warning?.('Stopping reply expansion early after consecutive throttled/empty reply responses');
      break;
    }
    if (parentsNeedingReplies.every((c) => isParentSatisfied(c.comment_id))) break;

    const markerId = `rbtn-${totalClicks + 1}`;
    const candidate = await findNextReplyExpander(page, {
      allowedTexts: allowedTexts.length > 0 ? allowedTexts : null,
      exhaustedTexts: getExhaustedTexts(),
      nextMarkerId: markerId,
    });

    if (!candidate) break;

    const textKey = candidate.commentText || `__anon_${markerId}`;
    const priorClicks = clicksByCommentText.get(textKey) || 0;
    if (priorClicks >= maxClicksPerParent) {
      await markExpanderExhausted(page, markerId);
      continue;
    }

    const replyCountBefore = state.replies.length;
    const responseSeqBefore = state.replyResponseSeq;

    try {
      const btn = await page.$(`[data-scraper-btn="${markerId}"]`);
      if (!btn) {
        await markExpanderExhausted(page, markerId);
        continue;
      }

      if (typeof btn.scrollIntoViewIfNeeded === 'function') {
        await btn.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      }
      await btn.click({ timeout: 3000 }).catch(async () => {
        await page.evaluate((id) => {
          document.querySelector(`[data-scraper-btn="${id}"]`)?.click();
        }, markerId);
      });
    } catch {
      await markExpanderExhausted(page, markerId);
      continue;
    }

    totalClicks += 1;
    clicksByCommentText.set(textKey, priorClicks + 1);

    // Wait for /api/comment/list/reply/ response (or error) to arrive
    await waitUntil(
      page,
      () => state.replyResponseSeq > responseSeqBefore || Boolean(state.fatalError),
      replyResponseTimeout
    );

    if (state.fatalError) break;

    const gained = state.replies.length - replyCountBefore;
    if (gained === 0) {
      // Button didn't yield any new replies — avoid clicking it again
      await markExpanderExhausted(page, markerId);
    }

    // Small pacing delay to avoid triggering TikTok rate limits
    if (replyClickDelay > 0) {
      await page.waitForTimeout(replyClickDelay);
    }
  }

  log?.info?.(`Reply expansion finished after ${totalClicks} clicks (${state.replies.length} replies captured)`);
}

/**
 * Navigate to a TikTok video URL, extract video metadata (if needed),
 * scrape top-level comments via /api/comment/list/, and optionally expand
 * nested replies via /api/comment/list/reply/.
 */
export async function scrapeVideoPage(page, videoUrl, options = {}) {
  const {
    includeComments = true,
    commentsPerPost = 20,
    includeReplies = true,
    repliesPerComment = 10,
    scrollDelay = 2000,
    stallLimit = 3,
    replyClickDelay = 1200,
    replyResponseTimeout = 3500,
    initialWaitMs = 3000,
    hydrationTimeoutMs = 15000,
    openTimeoutMs = 8000,
    extractVideo = false,
    skipCaptchaCheck = false,
    log = console,
  } = options;

  const state = {
    topComments: [],
    replies: [],
    topCommentIds: new Set(),
    replyIds: new Set(),
    replyCountByParent: new Map(),
    replyHasMoreByParent: new Map(),
    commentListHasMore: true,
    commentResponseSeq: 0,
    replyResponseSeq: 0,
    consecutiveReplyErrors: 0,
    interceptedVideo: null,
    fatalError: null,
  };

  const dedupSet = new Set();

  const recordReply = (reply) => {
    if (!reply?.comment_id || state.replyIds.has(reply.comment_id)) return;
    state.replyIds.add(reply.comment_id);
    state.replies.push(reply);
    if (reply.reply_id) {
      const parentId = String(reply.reply_id);
      state.replyCountByParent.set(parentId, (state.replyCountByParent.get(parentId) || 0) + 1);
    }
  };

  const interceptor = setupInterceptors(page, {
    endpoints: [
      ENDPOINTS.COMMENT_REPLY_LIST,
      ENDPOINTS.COMMENT_LIST,
      ...(extractVideo ? [ENDPOINTS.ITEM_DETAIL] : []),
    ],
    dedupSet,
    onItem: (item) => {
      if (item._type === 'video_detail') {
        const { _type, ...cleanVideo } = item;
        state.interceptedVideo = cleanVideo;
        return;
      }

      if (item._type === 'comment') {
        if (item.is_reply) {
          recordReply(item);
        } else if (!state.topCommentIds.has(item.comment_id)) {
          state.topCommentIds.add(item.comment_id);
          state.topComments.push(item);
        }
      }
    },
    onRaw: (raw) => {
      if (raw.endpoint === ENDPOINTS.COMMENT_LIST) {
        state.commentResponseSeq += 1;
        state.commentListHasMore = Boolean(raw.hasMore);
      } else if (raw.endpoint === ENDPOINTS.COMMENT_REPLY_LIST) {
        state.replyResponseSeq += 1;
        state.consecutiveReplyErrors = 0;
        try {
          const parentCid = new URL(raw.url).searchParams.get('comment_id');
          if (parentCid) {
            state.replyHasMoreByParent.set(parentCid, Boolean(raw.hasMore));
          }
        } catch {
          // Ignore URL parse error
        }
      }
    },
    onError: (err) => {
      if (err instanceof CaptchaError || err instanceof RateLimitError) {
        state.fatalError = err;
      } else {
        if (err.message?.includes(ENDPOINTS.COMMENT_REPLY_LIST)) {
          state.replyResponseSeq += 1;
          state.consecutiveReplyErrors += 1;
        }
        log?.warning?.(`Comment interceptor error: ${err.message}`);
      }
    },
  });

  try {
    // Navigate to video page (2 attempts, matching feed navigation resilience)
    let navigated = false;
    let lastGotoError = null;
    for (let attempt = 1; attempt <= 2 && !navigated; attempt += 1) {
      try {
        await page.goto(videoUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        navigated = true;
      } catch (err) {
        lastGotoError = err;
        log?.warning?.(`Video navigation attempt ${attempt}/2 failed: ${err.message.split('\n')[0]}`);
        if (attempt < 2) await page.waitForTimeout(1500);
      }
    }
    if (!navigated) throw lastGotoError;

    // Wait for TikTok's SPA to hydrate (either comment button/items appear or /api/comment/list/ fires)
    if (includeComments && typeof page.waitForSelector === 'function' && state.commentResponseSeq === 0) {
      try {
        await page.waitForSelector(VIDEO_HYDRATION_SELECTOR, {
          state: 'attached',
          timeout: hydrationTimeoutMs,
        });
      } catch {
        log?.warning?.('Timed out waiting for video page hydration selector; continuing');
      }
    }

    await waitUntil(
      page,
      () => Boolean(state.fatalError) || (includeComments && state.commentResponseSeq > 0),
      initialWaitMs
    );

    if (state.fatalError) throw state.fatalError;

    if (!skipCaptchaCheck) {
      try {
        if (await detectCaptcha(page)) {
          throw new CaptchaError(10000, 'Captcha wall detected on video page');
        }
      } catch (err) {
        if (err instanceof CaptchaError || err?.name === 'CaptchaError') throw err;
      }
    }

    await dismissModals(page);

    let video = null;
    if (extractVideo) {
      video = state.interceptedVideo;
      if (!video || !video.location_created) {
        const pageVideo = await extractVideoFromPage(page);
        if (video && pageVideo) {
          video = {
            ...pageVideo,
            ...video,
            location_created: video.location_created || pageVideo.location_created || null,
            region: video.region || pageVideo.region || null,
          };
        } else {
          video = video || pageVideo;
        }
      }
      if (!video) {
        const finalUrl = typeof page.url === 'function' ? page.url() : videoUrl;
        video = buildFallbackVideo(finalUrl, parseVideoQuery(videoUrl));
      }
    }

    let comments = [];
    if (includeComments) {
      // TikTok's desktop video page keeps the comment drawer closed until clicked
      if (state.topComments.length === 0 && state.commentResponseSeq === 0) {
        const opened = await ensureCommentsOpen(
          page,
          () => state.commentResponseSeq > 0 || state.topComments.length > 0 || Boolean(state.fatalError),
          { openTimeoutMs, log }
        );
        if (state.fatalError) throw state.fatalError;
        if (!opened) {
          log?.warning?.(`No /api/comment/list/ response captured after trying to open comments on ${videoUrl}`);
        }
      }

      // Let the initial comment list render in the DOM before scrolling/expanding replies
      if (state.topComments.length > 0 && typeof page.waitForSelector === 'function') {
        await page.waitForSelector('[data-e2e="comment-level-1"]', { timeout: 5000 }).catch(() => {});
      }

      // Paginate top-level comments via scrolling
      const maxScrolls = Math.min(100, Math.max(10, Math.ceil(commentsPerPost / 5) + 5));
      let stalls = 0;

      for (let scroll = 0; scroll < maxScrolls; scroll += 1) {
        if (state.fatalError) throw state.fatalError;
        if (state.topComments.length >= commentsPerPost) break;
        if (!state.commentListHasMore && state.commentResponseSeq > 0) break;

        const beforeCount = state.topComments.length;
        const seqBefore = state.commentResponseSeq;

        await scrollCommentsDown(page);

        await waitUntil(
          page,
          () => state.commentResponseSeq > seqBefore
            || state.topComments.length >= commentsPerPost
            || Boolean(state.fatalError),
          scrollDelay
        );

        if (state.fatalError) throw state.fatalError;

        if (state.topComments.length === beforeCount) {
          stalls += 1;
          if (stalls >= stallLimit) break;
        } else {
          stalls = 0;
        }
      }

      // Expand nested replies for collected top-level comments
      if (includeReplies && repliesPerComment > 0 && state.topComments.length > 0) {
        await expandCommentReplies(page, state, {
          commentsPerPost,
          repliesPerComment,
          replyClickDelay,
          replyResponseTimeout,
          log,
        });
        if (state.fatalError) throw state.fatalError;
      }

      comments = buildCommentTree(state.topComments, state.replies, {
        maxComments: commentsPerPost,
        includeReplies,
        maxRepliesPerComment: repliesPerComment,
      });
    }

    const totalNestedReplies = comments.reduce((sum, c) => sum + (c.reply_comments?.length || 0), 0);

    return {
      video,
      comments,
      stats: {
        topLevelCount: comments.length,
        replyCount: totalNestedReplies,
      },
    };
  } finally {
    interceptor.cleanup();
  }
}
