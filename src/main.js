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

  // Parse cookies
  let cookies = [];
  if (sessionCookies) {
    cookies = normalizeCookies(sessionCookies);
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
  const log = Actor.log;

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
  const crawler = new PlaywrightCrawler({
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
    proxyConfiguration: await Actor.createProxyConfiguration({
      groups: ['RESIDENTIAL'],
      countryCode: targetIdc === 'alisg' ? 'SG' : (targetIdc === 'useast2a' ? 'US' : undefined),
    }),
    async requestHandler({ page, request }) {
      const query = request.userData.query;

      // Setup resource blocking
      await setupResourceBlocking(page);

      // Inject cookies
      const context = page.context();
      await context.addCookies(config.cookies);

      // Scrape the query
      const result = await scrapeQuery(page, { log: Actor.log }, query, config);

      // Push items to dataset
      for (const item of result.items) {
        await Actor.pushData(item);
      }

      Actor.log.info(`Pushed ${result.items.length} items to dataset for query: "${query}"`);
    },
    async failedRequestHandler({ request, error }) {
      Actor.log.error(`Request failed for ${request.url}: ${error.message}`);
    },
  }, Configuration.getGlobalConfig());

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
