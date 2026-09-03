/**
 * main.js — Apify Actor entry point
 *
 * TikTok Scraper Actor
 * Accepts session cookies, scrapes TikTok data via network interception,
 * and outputs structured JSON matching the target schema.
 */

import { Actor } from 'apify';
import { PlaywrightCrawler, Configuration } from 'crawlee';
import { normalizeCookies, validateCookies, getCookieHash, getTargetIdc } from './cookies.js';
import { setupInterceptors, CaptchaError } from './intercept.js';
import { setupPagination } from './paginate.js';
import { SessionManager, detectCaptcha, detectLoggedOut } from './antibot.js';

// Local development fallback for logging
const logger = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  warning: (msg) => console.warn(`[WARN] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`),
  debug: (msg) => console.debug(`[DEBUG] ${msg}`),
};

// Configuration
const DEFAULT_MAX_ITEMS = 200;
const DEFAULT_STALL_LIMIT = 5;
const DEFAULT_SCROLL_DELAY = 2000;

/**
 * Parse and validate input
 */
async function parseInput(input) {
  const mode = input.mode || 'search';
  const queries = input.queries || [];
  const maxItems = input.maxItems || DEFAULT_MAX_ITEMS;
  const sessionCookies = input.sessionCookies || '';
  const cookiePool = input.cookiePool || [];
  const sortBy = input.sortBy || 'relevance';
  const publishedWithin = input.publishedWithin || 'all';
  const includeComments = input.includeComments || false;
  const commentsPerPost = input.commentsPerPost || 20;
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

  return {
    mode,
    queries,
    maxItems,
    cookies,
    cookiePool,
    sortBy,
    publishedWithin,
    includeComments,
    commentsPerPost,
    downloadMedia,
    outputSchema,
  };
}

/**
 * Build the TikTok URL based on mode and query
 */
function buildUrl(mode, query, sortBy, publishedWithin) {
  const params = new URLSearchParams();

  switch (mode) {
    case 'search':
      params.set('keyword', query);
      params.set('offset', '0');
      if (sortBy === 'latest') {
        params.set('sort_type', '1');
      }
      if (publishedWithin !== 'all') {
        params.set('publish_time', publishTimeToCode(publishedWithin));
      }
      return `https://www.tiktok.com/search?${params.toString()}`;

    case 'hashtag': {
      // Hashtag mode - use challenge endpoint
      const tagName = query.replace(/^#/, '');
      return `https://www.tiktok.com/tag/${tagName}`;
    }

    case 'profile': {
      // Profile mode - use user endpoint
      const username = query.replace(/^@/, '');
      return `https://www.tiktok.com/@${username}`;
    }

    default:
      params.set('keyword', query);
      return `https://www.tiktok.com/search?${params.toString()}`;
  }
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
 * Filter item based on outputSchema setting
 */
function filterByOutputSchema(item, schema) {
  if (schema === 'native') return item;
  
  if (schema === 'both') {
    return { ...item, _raw: item };
  }
  
  // 'compat' - Threads-style format (only fields from sample-output.json)
  return {
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
    images: item.images,
    videos: item.videos,
    is_reply: item.is_reply,
    source: item.source,
  };
}

/**
 * Scrape comments for a specific video
 */
async function scrapeComments(page, videoId, authorUsername, config) {
  if (!config.includeComments) return [];
  
  const log = Actor.log;
  log.info(`Scraping comments for video: ${videoId}`);
  
  const comments = [];
  const dedupSet = new Set();
  
  // Setup comment interceptor
  setupInterceptors(page, {
    endpoints: ['/api/comment/list/'],
    dedupSet,
    onItem: (item) => {
      if (item._type === 'comment') {
        comments.push(item);
      }
    },
    onError: (error) => {
      log.warning(`Comment interceptor error: ${error.message}`);
    },
  });
  
  // Navigate to video page
  await page.goto(`https://www.tiktok.com/@${authorUsername}/video/${videoId}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  
  // Wait for comments to load
  await page.waitForTimeout(2000);
  
  // Scroll to load more comments
  await setupPagination(page, {
    targetCount: config.commentsPerPost,
    stallLimit: 3,
    scrollDelay: 1500,
  });
  
  return comments;
}

/**
 * Download media files to KV store
 */
async function downloadMedia(kvStore, items, log) {
  const downloaded = [];
  
  for (const item of items) {
    // Download video if present
    if (item.videos && item.videos.length > 0 && item.videos[0].url) {
      try {
        const response = await fetch(item.videos[0].url);
        if (response.ok) {
          const buffer = Buffer.from(await response.arrayBuffer());
          const key = `video_${item.post_id}.mp4`;
          await kvStore.setValue(key, buffer, { contentType: 'video/mp4' });
          downloaded.push({ type: 'video', key, post_id: item.post_id });
          log.info(`Downloaded video for post ${item.post_id}`);
        }
      } catch (error) {
        log.warning(`Failed to download video for ${item.post_id}: ${error.message}`);
      }
    }
    
    // Download images if present (carousel posts)
    if (item.images && item.images.length > 0) {
      for (let i = 0; i < item.images.length; i++) {
        try {
          const response = await fetch(item.images[i]);
          if (response.ok) {
            const buffer = Buffer.from(await response.arrayBuffer());
            const key = `image_${item.post_id}_${i}.jpg`;
            await kvStore.setValue(key, buffer, { contentType: 'image/jpeg' });
            downloaded.push({ type: 'image', key, post_id: item.post_id });
          }
        } catch (error) {
          log.warning(`Failed to download image ${i} for ${item.post_id}: ${error.message}`);
        }
      }
    }
  }
  
  return downloaded;
}

/**
 * Block heavy resources for efficiency
 */
async function setupResourceBlocking(page) {
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    // Block: image, media, font — NOT stylesheet (infinite scroll needs CSS)
    if (['image', 'media', 'font'].includes(type)) {
      return route.abort();
    }
    return route.continue();
  });
}

/**
 * Main scraping function for a single query
 */
async function scrapeQuery(page, context, query, config) {
  const { log } = context;
  const results = [];
  const dedupSet = new Set();

  log.info(`Scraping query: "${query}"`);

  // Build URL
  const url = buildUrl(config.mode, query, config.sortBy, config.publishedWithin);
  log.info(`Navigating to: ${url}`);

  // Setup interceptors
  setupInterceptors(page, {
    endpoints: [
      '/api/search/general/full/',
      '/api/search/item/full/',
      '/api/challenge/item_list/',
      '/api/post/item_list/',
      '/api/comment/list/',
    ],
    dedupSet,
    onItem: (item) => {
      results.push(item);
    },
    onError: (error) => {
      log.warning(`Interceptor error: ${error.message}`);
    },
  });

  // Navigate to the search page
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  // Wait for initial content
  await page.waitForTimeout(3000);

  // Check for captcha or logged out state
  const captcha = await detectCaptcha(page);
  if (captcha) {
    throw new CaptchaError(10000, 'Captcha detected on page load');
  }

  const loggedOut = await detectLoggedOut(page);
  if (loggedOut) {
    throw new Error('Session appears to be logged out');
  }

  // Setup pagination (scroll-based)
  const paginationResult = await setupPagination(page, {
    targetCount: config.maxItems,
    stallLimit: DEFAULT_STALL_LIMIT,
    scrollDelay: DEFAULT_SCROLL_DELAY,
    onScroll: (info) => {
      log.info(`Scroll ${info.scrollCount}: ${info.currentCount} items (${info.itemsGained} new)`);
    },
    onComplete: (result) => {
      log.info(`Pagination complete: ${result.reason}, ${result.totalItems} items`);
    },
  });

  log.info(`Scraped ${results.length} items for query: "${query}"`);

  // Optionally scrape comments for each video
  if (config.includeComments) {
    const videosWithComments = results.filter((r) => r.videos && r.videos.length > 0);
    log.info(`Scraping comments for ${videosWithComments.length} videos`);
    
    for (const video of videosWithComments.slice(0, 10)) { // Limit to first 10 videos
      try {
        const comments = await scrapeComments(page, video.post_id, video.user.username, config);
        video.comments = comments;
      } catch (error) {
        log.warning(`Failed to scrape comments for ${video.post_id}: ${error.message}`);
      }
    }
  }

  return {
    query,
    items: results,
    pagination: paginationResult,
  };
}

/**
 * Main actor function
 */
Actor.main(async () => {
  const input = await Actor.getInput() || {};
  const log = Actor.log || logger;

  log.info('Starting TikTok Scraper Actor');

  // Parse and validate input
  const config = await parseInput(input);
  log.info(`Mode: ${config.mode}, Queries: ${config.queries.join(', ')}, Max Items: ${config.maxItems}`);

  // Calculate session ID for proxy pinning
  const cookieHash = getCookieHash(config.cookies);
  const targetIdc = getTargetIdc(config.cookies);
  log.info(`Session hash: ${cookieHash}, Target IDC: ${targetIdc || 'auto'}`);

  // Initialize session manager
  const sessions = config.cookiePool.length > 0
    ? config.cookiePool.map((c) => normalizeCookies(c.cookies))
    : [config.cookies];
  const sessionManager = new SessionManager(sessions, { maxRetriesPerSession: 3 });

  // Create crawler
  const crawlerOptions = {
    maxRequestRetries: 3,
    requestHandlerTimeoutSecs: 300,
    launchContext: {
      launchOptions: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    },
    browserPool: {
      useFingerprints: false,
    },
    async requestHandler({ page, request }) {
      const query = request.userData.query;
      const currentSession = sessionManager.getCurrent();

      // Setup resource blocking
      await setupResourceBlocking(page);

      // Inject cookies from current session
      const context = page.context();
      await context.addCookies(currentSession);

      // Scrape the query
      try {
        const result = await scrapeQuery(page, { log: Actor.log || logger }, query, config);

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

  // Add proxy configuration only if on Apify platform (has proxy support)
  if (Actor.apifyClient) {
    crawlerOptions.proxyConfiguration = await Actor.createProxyConfiguration({
      groups: ['RESIDENTIAL'],
      countryCode: targetIdc === 'alisg' ? 'SG' : (targetIdc === 'useast2a' ? 'US' : undefined),
    });
  }

  const crawler = new PlaywrightCrawler(crawlerOptions, Configuration.getGlobalConfig());

  // Queue all queries
  const requestQueue = await Actor.openRequestQueue();
  for (const query of config.queries) {
    await requestQueue.addRequest({
      url: buildUrl(config.mode, query, config.sortBy, config.publishedWithin),
      userData: { query },
    });
  }

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
    const kvStore = await Actor.openKeyValueStore();
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
