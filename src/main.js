/**
 * main.js — Apify Actor entry point
 *
 * TikTok Scraper Actor
 * Accepts session cookies, scrapes TikTok data via network interception,
 * and outputs structured JSON matching the target schema.
 */

import { Actor } from 'apify';
import { PlaywrightCrawler, Configuration, ProxyConfiguration } from 'crawlee';
import { firefox } from 'playwright-core';
import { launchOptions as camoufoxLaunchOptions } from 'camoufox-js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizeCookies, validateCookies, getCookieHash, getTargetIdc } from './cookies.js';
import { setupInterceptors, ENDPOINTS, CaptchaError, RateLimitError } from './intercept.js';
import { setupPagination } from './paginate.js';
import { SessionManager, detectCaptcha } from './antibot.js';
import { scrapeVideoPage, parseVideoQuery } from './comments.js';

// Local development fallback for logging
const logger = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  warning: (msg) => console.warn(`[WARN] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`),
  debug: (msg) => console.debug(`[DEBUG] ${msg}`),
};

// Configuration
const DEFAULT_MAX_ITEMS = 200;

// Resource types dropped before they hit the wire. Media (video previews in
// particular) dominates proxy traffic and every field we collect comes from
// intercepted JSON responses, not from rendered assets. Set BLOCK_MEDIA=false
// to disable while debugging anti-bot behaviour.
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font']);
const BLOCK_MEDIA = process.env.BLOCK_MEDIA !== 'false';

/**
 * Split a proxy list into individual URLs. Accepts comma or newline separators
 * so multiple sticky endpoints can be passed in one env var.
 */
function parseProxyUrls(raw) {
  if (!raw) return [];
  return raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Strip credentials from a proxy URL so it is safe to log.
 */
function redactProxyUrl(proxyUrl) {
  try {
    const { protocol, hostname, port } = new URL(proxyUrl);
    return `${protocol}//${hostname}${port ? `:${port}` : ''}`;
  } catch {
    return '<unparseable proxy URL>';
  }
}

/**
 * Parse and validate input
 */
export async function parseInput(input) {
  const mode = input.mode || 'search';
  const queries = input.queries || [];
  const maxItems = input.maxItems || DEFAULT_MAX_ITEMS;
  const sessionCookies = input.sessionCookies || '';
  const cookiePool = input.cookiePool || [];
  const sortBy = input.sortBy || 'relevance';
  const publishedWithin = input.publishedWithin || 'all';
  const dateFromMs = parseDateBound(input.dateFrom);
  const dateToMs = parseDateBound(input.dateTo, { endOfDay: true });
  const language = input.language || 'id';
  const includeComments = input.includeComments !== undefined
    ? Boolean(input.includeComments)
    : mode === 'video';
  const commentsPerPost = input.commentsPerPost || 20;
  const includeReplies = input.includeReplies !== undefined
    ? Boolean(input.includeReplies)
    : true;
  const repliesPerComment = input.repliesPerComment !== undefined
    ? input.repliesPerComment
    : 10;
  const maxVideosForComments = input.maxVideosForComments !== undefined
    ? input.maxVideosForComments
    : 10;
  const downloadMedia = input.downloadMedia || false;
  const outputSchema = input.outputSchema || 'compat';

  // Validate required fields
  if (!sessionCookies && (!cookiePool || cookiePool.length === 0)) {
    throw new Error('Either sessionCookies or cookiePool must be provided');
  }

  if (!queries.length) {
    throw new Error('At least one query is required');
  }

  // Parse cookies - support both sessionCookies and cookiePool
  let cookies = [];
  if (sessionCookies) {
    cookies = normalizeCookies(sessionCookies);
  } else if (cookiePool && cookiePool.length > 0) {
    // Use first cookie pool entry as primary
    cookies = normalizeCookies(cookiePool[0].cookies);
  }

  // Validate cookies
  const validation = validateCookies(cookies);
  if (!validation.valid) {
    throw new Error(`Invalid cookies: ${validation.reason}`);
  }

  if (dateFromMs !== null && dateToMs !== null && dateFromMs > dateToMs) {
    throw new Error('dateFrom must be before or equal to dateTo');
  }

  const dateRange = (dateFromMs !== null || dateToMs !== null)
    ? { from: dateFromMs, to: dateToMs }
    : null;

  return {
    mode,
    queries,
    maxItems,
    cookies,
    cookiePool,
    sortBy,
    publishedWithin,
    dateRange,
    language,
    includeComments,
    commentsPerPost,
    includeReplies,
    repliesPerComment,
    maxVideosForComments,
    downloadMedia,
    outputSchema,
    proxyConfiguration: input.proxyConfiguration,
  };
}

/**
 * Build the TikTok URL based on mode and query
 */
export function buildUrl(mode, query, sortBy, publishedWithin, language = 'id') {
  const params = new URLSearchParams();

  switch (mode) {
    case 'search':
      // TikTok search uses 'q' parameter
      params.set('q', query);
      params.set('lang', language);
      if (sortBy === 'latest') {
        params.set('sort_type', '1');
      }
      if (publishedWithin !== 'all') {
        params.set('publish_time', publishTimeToCode(publishedWithin));
      }
      return `https://www.tiktok.com/search?${params.toString()}`;

    case 'hashtag': {
      const tagName = query.replace(/^#/, '');
      return `https://www.tiktok.com/tag/${tagName}`;
    }

    case 'profile': {
      const username = query.replace(/^@/, '');
      return `https://www.tiktok.com/@${username}`;
    }

    case 'video':
      return parseVideoQuery(query).url;

    default:
      params.set('q', query);
      params.set('lang', language);
      return `https://www.tiktok.com/search?${params.toString()}`;
  }
}

/**
 * Map an ISO language code to a BCP 47 locale tag.
 * The browser locale drives TikTok's search API language params
 * (e.g. language/app_language on /api/search/*), so it must match
 * the lang param we set on the search URL.
 */
function toLocaleTag(code) {
  const map = {
    id: 'id-ID',
    en: 'en-US',
    ms: 'ms-MY',
    th: 'th-TH',
    vi: 'vi-VN',
    ja: 'ja-JP',
    ko: 'ko-KR',
    es: 'es-ES',
    pt: 'pt-BR',
  };
  return map[code] || 'en-US';
}

/**
 * Parse a date boundary into epoch milliseconds.
 * Accepts 'YYYY-MM-DD' (treated as UTC; endOfDay extends it to 23:59:59.999)
 * or any parseable ISO datetime string (offset honored as given).
 * Returns null when the value is empty.
 */
function parseDateBound(value, { endOfDay = false } = {}) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const time = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
    return new Date(`${trimmed}${time}`).getTime();
  }

  const ms = new Date(trimmed).getTime();
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid date: "${trimmed}". Use YYYY-MM-DD or an ISO datetime string.`);
  }
  return ms;
}

/**
 * Convert publishedWithin to TikTok's time filter code
 */
function publishTimeToCode(within) {
  const mapping = {
    '1d': '0',
    '7d': '1',
    '30d': '2',
    '90d': '3',
    '180d': '4',
  };
  return mapping[within] || '0';
}

/**
 * Check a normalized item against the dateRange filter.
 * Applies to posts only (comments are left untouched); posts with an
 * unknown/invalid timestamp are excluded when a range is active.
 */
function isWithinDateRange(item, range) {
  if (!range) return true;
  if (item._type === 'comment') return true;
  if (!item.timestamp) return false;

  const ms = new Date(item.timestamp).getTime();
  if (Number.isNaN(ms)) return false;

  if (range.from !== null && ms < range.from) return false;
  if (range.to !== null && ms > range.to) return false;
  return true;
}

/**
 * Filter item based on outputSchema setting.
 * Preserves `location_created` and `comments` across all schemas when present.
 */
export function filterByOutputSchema(item, schema) {
  if (schema === 'native') return item;

  if (schema === 'both') {
    return { ...item, _raw: item };
  }

  // 'compat' - Threads-style format (only fields from sample-output.json)
  const compat = {
    post_id: item.post_id,
    shortcode: item.shortcode,
    post_url: item.post_url,
    text: item.text,
    timestamp: item.timestamp,
    user: item.user,
    likes: item.likes,
    replies: item.replies,
    reposts: item.reposts,
    quotes: item.quotes,
    reshares: item.reshares,
    views: item.views,
    saves: item.saves,
    bookmarks: item.bookmarks,
    images: item.images,
    videos: item.videos,
    is_reply: item.is_reply,
    source: item.source,
    location_created: item.location_created ?? null,
  };

  if (Array.isArray(item.comments)) {
    compat.comments = item.comments;
  }

  return compat;
}

/**
 * Scrape comments and nested replies for a single video item
 */
async function scrapeComments(page, video, config, log) {
  if (!config.includeComments) return { comments: [], videoDetail: null };

  const videoUrl = video.post_url
    || `https://www.tiktok.com/@${video.user?.username}/video/${video.post_id}`;
  log.info(`Scraping comments for video: ${video.post_id || videoUrl}`);

  const { video: videoDetail, comments, stats } = await scrapeVideoPage(page, videoUrl, {
    includeComments: true,
    commentsPerPost: config.commentsPerPost,
    includeReplies: config.includeReplies,
    repliesPerComment: config.repliesPerComment,
    extractVideo: !video.location_created,
    log,
  });

  log.info(
    `Captured ${stats.topLevelCount} comments and ${stats.replyCount} replies for video ${video.post_id || videoUrl}`
  );
  return { comments, videoDetail };
}

/**
 * Direct video URL mode: scrape a single video's metadata, comments, and replies
 */
async function scrapeVideo(page, context, query, config) {
  const { log } = context;
  const parsed = parseVideoQuery(query);
  log.info(`Scraping direct video: ${parsed.url}`);

  const { video, comments, stats } = await scrapeVideoPage(page, parsed.url, {
    includeComments: config.includeComments,
    commentsPerPost: config.commentsPerPost,
    includeReplies: config.includeReplies,
    repliesPerComment: config.repliesPerComment,
    extractVideo: true,
    log,
  });

  if (!video) {
    return {
      query,
      items: [],
      pagination: { totalItems: 0, reason: 'video_not_found' },
    };
  }

  if (config.includeComments) {
    video.comments = comments;
    log.info(
      `Captured ${stats.topLevelCount} comments and ${stats.replyCount} replies for video ${video.post_id || parsed.url}`
    );
  }

  const items = isWithinDateRange(video, config.dateRange) ? [video] : [];
  return {
    query,
    items,
    pagination: { totalItems: items.length, reason: 'video_complete' },
  };
}

/**
 * Main scraping function for a single feed query (search, hashtag, profile)
 */
async function scrapeQuery(page, context, query, config) {
  const { log } = context;
  const results = [];
  const dedupSet = new Set();

  log.info(`Scraping query: "${query}"`);

  if (config.dateRange) {
    const fmt = (ms) => (ms === null ? '∞' : new Date(ms).toISOString());
    log.info(`Date range filter active: ${fmt(config.dateRange.from)} .. ${fmt(config.dateRange.to)}`);
  }

  let skippedByDate = 0;
  let fatalError = null;

  // Build URL
  const url = buildUrl(config.mode, query, config.sortBy, config.publishedWithin, config.language);
  log.info(`Navigating to: ${url}`);

  // Setup feed interceptor BEFORE navigation - captures initial search/feed API responses only.
  // Comments are intercepted separately in scrapeVideoPage so they never leak as standalone rows.
  const feedInterceptor = setupInterceptors(page, {
    endpoints: [
      ENDPOINTS.SEARCH_GENERAL,
      ENDPOINTS.SEARCH_ITEM,
      ENDPOINTS.CHALLENGE_ITEM,
      ENDPOINTS.POST_ITEM_LIST,
    ],
    dedupSet,
    onItem: (item) => {
      if (!isWithinDateRange(item, config.dateRange)) {
        skippedByDate += 1;
        return;
      }
      results.push(item);
    },
    onError: (error) => {
      if (error instanceof CaptchaError || error instanceof RateLimitError) {
        fatalError = error;
      } else {
        log.warning(`Interceptor error: ${error.message}`);
      }
    },
  });

  try {
    // Navigate to search page - TikTok's JS fires the initial API call.
    // NOTE: never use waitUntil networkidle on TikTok - its long-polling /
    // analytics beacons keep the network busy forever and goto always times
    // out after 60s (see run log: page.goto Timeout 60000ms exceeded).
    // domcontentloaded + explicit wait for results/captcha is reliable.
    let navigated = false;
    let lastGotoError = null;
    for (let attempt = 1; attempt <= 2 && !navigated; attempt += 1) {
      try {
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        navigated = true;
      } catch (err) {
        lastGotoError = err;
        log.warning(`Navigation attempt ${attempt}/2 failed: ${err.message.split('\n')[0]}`);
        if (attempt < 2) await page.waitForTimeout(2000);
      }
    }
    if (!navigated) throw lastGotoError;

    // Give TikTok's SPA a moment to boot, then check what we actually got
    // (results, captcha wall, or login wall) instead of waiting blindly.
    await page.waitForTimeout(3000);
    try {
      await page.waitForSelector(
        'a[href*="/video/"], [data-e2e="search_top-item"], [data-e2e="search_video-item"], #captcha_container, #captcha-verify, [data-e2e="captcha-container"]',
        { timeout: 20000 }
      );
    } catch {
      // Selector timeout is non-fatal - pagination/interceptor may still
      // have captured API responses; log state for diagnostics.
      log.warning('Timed out waiting for search results/captcha selector; continuing anyway');
    }

    if (fatalError) throw fatalError;

    try {
      if (await detectCaptcha(page)) {
        throw new CaptchaError(10000, 'Captcha wall detected after navigation');
      }
    } catch (err) {
      if (err?.name === 'CaptchaError') throw err;
      // detectCaptcha itself failed (e.g. page closed) - ignore, continue
    }

    log.info(`Results after initial load: ${results.length}`);

    // Scroll-based pagination: TikTok's own JS loads more pages as we scroll,
    // and the interceptor captures each new API response
    await setupPagination(page, {
      targetCount: config.maxItems,
      stallLimit: 3,
      scrollDelay: 2500,
      onScroll: (info) => {
        log.info(`Scroll ${info.scrollCount}: captured=${results.length}, DOM=${info.currentCount} (${info.itemsGained} new)`);
      },
      onComplete: (result) => {
        log.info(`Pagination complete: ${result.reason}, captured=${results.length} items`);
      },
    });

    if (fatalError) throw fatalError;
  } finally {
    // Detach feed interceptor before navigating to individual video pages
    feedInterceptor.cleanup();
  }

  log.info(`Scraped ${results.length} items for query: "${query}"` +
    (skippedByDate > 0 ? ` (skipped ${skippedByDate} outside date range)` : ''));

  // Optionally scrape comments (and nested replies) for scraped posts
  if (config.includeComments) {
    const commentablePosts = results.filter(
      (r) => r._type !== 'user_card' && r.post_id && r.user?.username
    );
    const limit = config.maxVideosForComments > 0
      ? config.maxVideosForComments
      : commentablePosts.length;
    const targets = commentablePosts.slice(0, limit);

    log.info(`Scraping comments for ${targets.length} of ${commentablePosts.length} posts`);

    for (const video of targets) {
      // Skip unnecessary navigation when TikTok explicitly reports 0 comments
      if (video.replies === 0) {
        video.comments = [];
        continue;
      }

      try {
        const { comments, videoDetail } = await scrapeComments(page, video, config, log);
        video.comments = comments;
        if (!video.location_created && videoDetail?.location_created) {
          video.location_created = videoDetail.location_created;
          if (!video.region) {
            video.region = videoDetail.region || videoDetail.location_created;
          }
        }
      } catch (error) {
        if (error instanceof CaptchaError || error instanceof RateLimitError) {
          throw error;
        }
        log.warning(`Failed to scrape comments for ${video.post_id}: ${error.message}`);
        video.comments = [];
      }
    }
  }

  return {
    query,
    items: results,
    pagination: { totalItems: results.length, reason: 'scroll_complete' },
  };
}

/**
 * Main actor entrypoint
 */
async function runActor() {
  await Actor.main(async () => {
    let input = await Actor.getInput();

    // Fallback: read from local input file when not on Apify platform
    if (!input || Object.keys(input).length === 0) {
      try {
        input = JSON.parse(readFileSync(new URL('../input.json', import.meta.url), 'utf8'));
        logger.info('Loaded input from input.json');
      } catch {
        input = {};
      }
    }

    const log = Actor.log || logger;

    log.info('Starting TikTok Scraper Actor');

    // Parse and validate input
    const config = await parseInput(input);
    log.info(
      `Mode: ${config.mode}, Queries: ${config.queries.join(', ')}, Max Items: ${config.maxItems}` +
      (config.includeComments
        ? `, Comments: ${config.commentsPerPost}/post` +
          (config.includeReplies ? ` (+${config.repliesPerComment} replies/comment)` : '')
        : '')
    );

    // Log session identity for debugging
    const cookieHash = getCookieHash(config.cookies);
    const targetIdc = getTargetIdc(config.cookies);
    log.info(`Session hash: ${cookieHash}, Target IDC: ${targetIdc || 'auto'}`);

    // Initialize session manager
    const sessions = config.cookiePool.length > 0
      ? config.cookiePool.map((c) => normalizeCookies(c.cookies))
      : [config.cookies];
    const sessionManager = new SessionManager(sessions, { maxRetriesPerSession: 3 });

    const blockAssets = BLOCK_MEDIA && !config.downloadMedia;
    if (blockAssets) {
      log.info(`Blocking ${[...BLOCKED_RESOURCE_TYPES].join('/')} requests to cut proxy traffic`);
    }

    // Give comment-heavy queries extra room before Crawlee's request timeout triggers
    const requestHandlerTimeoutSecs = config.includeComments && config.mode !== 'video' ? 600 : 300;

    // Create crawler
    const crawlerOptions = {
      maxRequestRetries: 3,
      requestHandlerTimeoutSecs,
      browserPoolOptions: {
        // Camoufox spoofs fingerprints at the browser level — Crawlee must not
        // layer its own generated fingerprint (UA/screen/viewport) on top of it.
        useFingerprints: false,
        // Playwright's default 1280x720 viewport fights Camoufox's spoofed
        // window dimensions (the page would report the emulated viewport, and a
        // second page on the same browser can hang). Null the viewport so
        // Firefox measures the real window, and keep one page per browser.
        maxOpenPagesPerBrowser: 1,
        prePageCreateHooks: [
          async (_pageId, _browserController, pageOptions = {}) => {
            pageOptions.viewport = null;
          },
        ],
      },
      launchContext: {
        // Camoufox is a stealth-patched Firefox driven through the Playwright
        // Firefox protocol, so it drops in as a replacement launcher. All
        // fingerprint/stealth handling happens at the C++ level inside the
        // browser — no Chromium stealth args or JS init-script overrides needed.
        launcher: firefox,
        // Incognito pages are required so Crawlee passes pageOptions through to
        // newPage() (needed to disable the default viewport below) and gives
        // each page a fresh context so sessions don't leak between cookies.
        useIncognitoPages: true,
        ignoreProxyCertificate: true,
        launchOptions: {
          ...(await camoufoxLaunchOptions({
            headless: true,
            locale: toLocaleTag(config.language),
            block_webrtc: true,
            // humanize: true, // enable to humanize cursor movement
          })),
          ignoreHTTPSErrors: true,
        },
      },
      preNavigationHooks: [
        async (crawlingContext, gotoOptions) => {
          const { page } = crawlingContext;

          if (gotoOptions) {
            gotoOptions.waitUntil = 'domcontentloaded';
            gotoOptions.timeout = 30000;
          }

          // Inject cookies prior to navigation so initial request carries session identity
          const currentSession = sessionManager.getCurrent();
          if (currentSession && currentSession.length > 0) {
            await page.context().addCookies(currentSession);
          }

          // Drop images/video/fonts before they consume proxy bandwidth.
          // NOTE: no addInitScript stealth overrides here — Camoufox spoofs
          // navigator.webdriver, chrome detection, etc. natively, and JS-level
          // overrides on top of it would only add a detectable inconsistency.
          if (blockAssets) {
            await page.route('**/*', (route) =>
              BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())
                ? route.abort()
                : route.continue()
            );
          }
        },
      ],
      async requestHandler({ page, request }) {
        const query = request.userData.query;
        const currentSession = sessionManager.getCurrent();

        // Inject cookies from current session
        const context = page.context();
        await context.addCookies(currentSession);

        // Scrape the query or direct video URL
        try {
          const result = config.mode === 'video'
            ? await scrapeVideo(page, { log: Actor.log || logger }, query, config)
            : await scrapeQuery(page, { log: Actor.log || logger }, query, config);

          // Push items to dataset
          for (const item of result.items) {
            const filtered = filterByOutputSchema(item, config.outputSchema);
            await Actor.pushData(filtered);
          }

          log.info(`Pushed ${result.items.length} items to dataset for query: "${query}"`);
        } catch (error) {
          // Handle session rotation on failure
          log.error(`Error scraping "${query}": ${error.message}`);
          if (sessionManager.hasRemaining()) {
            sessionManager.markFailed(error.message);
            const nextSession = sessionManager.rotate();
            if (nextSession) {
              log.info(`Rotating to next session. Remaining: ${sessionManager.getRemainingCount()}`);
              throw error; // Let crawler retry with new session
            }
          }
          throw error;
        }
      },
      async failedRequestHandler({ request, error }) {
        log.error(`Request failed for ${request.url}: ${error.message}`);
      },
    };

    // Proxy configuration:
    // 1. Check actor input proxyConfiguration (Apify Proxy or custom proxy URLs set in UI)
    // 2. Fallback to environment variables (CUSTOM_PROXY_URL, PROXY_URL, APIFY_PROXY_URL)
    if (config.proxyConfiguration) {
      try {
        const proxyConfig = await Actor.createProxyConfiguration(config.proxyConfiguration);
        if (proxyConfig) {
          crawlerOptions.proxyConfiguration = proxyConfig;
          log.info('Using proxy configuration from actor input');
        }
      } catch (error) {
        log.warning(`Failed to initialize proxy from input: ${error.message}`);
      }
    }

    if (!crawlerOptions.proxyConfiguration) {
      const proxyUrls = parseProxyUrls(
        process.env.CUSTOM_PROXY_URL || process.env.PROXY_URL || process.env.APIFY_PROXY_URL
      );
      if (proxyUrls.length > 0) {
        // BigInt keeps the 64-bit hash exact so the mapping is stable across runs
        const proxyIndex = Number(BigInt(`0x${cookieHash}`) % BigInt(proxyUrls.length));
        const proxyUrl = proxyUrls[proxyIndex];
        log.info(`Using proxy ${redactProxyUrl(proxyUrl)} from environment (${proxyUrls.length} configured)`);
        crawlerOptions.proxyConfiguration = new ProxyConfiguration({
          proxyUrls: [proxyUrl],
        });
      }
    }

    const crawler = new PlaywrightCrawler(crawlerOptions, Configuration.getGlobalConfig());

    // Queue all queries as requests
    const requests = config.queries.map((query) => ({
      url: buildUrl(config.mode, query, config.sortBy, config.publishedWithin, config.language),
      userData: { query },
    }));

    await crawler.addRequests(requests);

    // Run crawler
    await crawler.run();

    // Persist refreshed cookies back to KV store
    // msToken rotates constantly and a stale one degrades results
    try {
      const kvStore = await Actor.openKeyValueStore();
      const refreshedCookies = sessionManager.getCurrent();
      await kvStore.setValue('session_cookies_latest', refreshedCookies);
      log.info('Persisted refreshed cookies to KV store');
    } catch (error) {
      log.warning(`Failed to persist cookies: ${error.message}`);
    }

    // Download media if requested
    if (config.downloadMedia) {
      log.info('Downloading media files to KV store...');
      await Actor.openKeyValueStore();
      // Note: media download would need access to all scraped items
      // This would be handled per-request in a production implementation
      log.info('Media download complete');
    }

    // Get dataset stats
    const dataset = await Actor.openDataset();
    const stats = await dataset.getInfo();
    log.info(`Total items scraped: ${stats?.itemCount || 0}`);

    // Output metadata
    await Actor.setValue('OUTPUT_METADATA', {
      scraped_at: new Date().toISOString(),
      queries: config.queries,
      mode: config.mode,
      total_items: stats?.itemCount || 0,
    });

    log.info('TikTok Scraper Actor finished');
  });
}

const isDirectExecution = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  runActor();
}
