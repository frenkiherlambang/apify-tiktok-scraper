import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  normalizeComment,
  normalizeCommentList,
  normalizeCommentReplyList,
  buildCommentTree,
} from '../src/normalize/comment.js';
import { normalizeVideoItem } from '../src/normalize/shared.js';
import {
  setupInterceptors,
  ENDPOINTS,
  CaptchaError,
  RateLimitError,
} from '../src/intercept.js';
import {
  parseVideoQuery,
  scrapeVideoPage,
} from '../src/comments.js';
import {
  parseInput,
  buildUrl,
  filterByOutputSchema,
} from '../src/main.js';

const VALID_COOKIES = 'sessionid=s1; sessionid_ss=s2; sid_tt=s3; sid_guard=s4';

function makeResponse(url, json, status = 200) {
  return {
    url: () => url,
    status: () => status,
    json: async () => json,
  };
}

test('normalizeVideoItem extracts location_created from locationCreated, location_created, and region fallbacks', () => {
  const fromCamel = normalizeVideoItem({
    id: '1',
    desc: 'Video 1',
    locationCreated: 'ID',
    author: { id: 'a1', uniqueId: 'u1' },
    stats: { diggCount: 1, commentCount: 0, shareCount: 0, playCount: 10 },
  });
  assert.equal(fromCamel.location_created, 'ID');
  assert.equal(fromCamel.region, 'ID');

  const fromSnake = normalizeVideoItem({
    id: '2',
    desc: 'Video 2',
    location_created: 'US',
    author: { id: 'a2', uniqueId: 'u2' },
    stats: {},
  });
  assert.equal(fromSnake.location_created, 'US');
  assert.equal(fromSnake.region, 'US');

  const fromRegion = normalizeVideoItem({
    id: '3',
    desc: 'Video 3',
    regionCode: 'MY',
    author: { id: 'a3', uniqueId: 'u3' },
    stats: {},
  });
  assert.equal(fromRegion.location_created, 'MY');
  assert.equal(fromRegion.region, 'MY');

  const empty = normalizeVideoItem({
    id: '4',
    desc: 'Video 4',
    locationCreated: '   ',
    author: { id: 'a4', uniqueId: 'u4' },
    stats: {},
  });
  assert.equal(empty.location_created, null);
  assert.equal(empty.region, null);
});

test('normalizeCommentList normalizes top-level comments and inline preview replies', () => {
  const seen = new Set();
  const payload = {
    status_code: 0,
    has_more: 1,
    comments: [
      {
        cid: '100',
        aweme_id: '999',
        text: 'First comment',
        create_time: 1700000000,
        digg_count: 15,
        reply_comment_total: 2,
        reply_id: '0',
        reply_to_reply_id: '0',
        author_pin: true,
        is_author_digged: true,
        user: {
          uid: 'u1',
          unique_id: 'alice',
          nickname: 'Alice',
          avatar_thumb: { url_list: ['https://cdn.example/a.jpg'] },
          verified: true,
        },
        reply_comment: [
          {
            cid: '101',
            aweme_id: '999',
            text: 'Inline preview reply',
            create_time: 1700000060,
            digg_count: 3,
            reply_id: '100',
            reply_to_reply_id: '0',
            reply_to_username: 'alice',
            user: { uid: 'u2', unique_id: 'bob', nickname: 'Bob' },
          },
        ],
      },
    ],
  };

  const items = normalizeCommentList(payload, seen);
  assert.equal(items.length, 2);

  const [parent, previewReply] = items;
  assert.equal(parent.comment_id, '100');
  assert.equal(parent.is_reply, false);
  assert.equal(parent.is_pinned, true);
  assert.equal(parent.is_author_liked, true);
  assert.equal(parent.sub_comment_count, 2);
  assert.deepEqual(parent.reply_comments, []);

  assert.equal(previewReply.comment_id, '101');
  assert.equal(previewReply.is_reply, true);
  assert.equal(previewReply.reply_id, '100');
  assert.equal(previewReply.reply_to_username, 'alice');
  assert.equal(previewReply.reply_comments, undefined);
});

test('normalizeCommentReplyList uses fallbackParentId and deduplicates', () => {
  const seen = new Set(['101']);
  const payload = {
    status_code: 0,
    comments: [
      { cid: '101', text: 'Duplicate reply', user: { unique_id: 'bob' } },
      { cid: '102', text: 'Second reply', reply_id: '0', user: { unique_id: 'carol' } },
    ],
  };

  const replies = normalizeCommentReplyList(payload, seen, '100');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].comment_id, '102');
  assert.equal(replies[0].is_reply, true);
  assert.equal(replies[0].reply_id, '100');
});

test('buildCommentTree nests replies under parents and enforces caps', () => {
  const top = [
    normalizeComment({ cid: '1', text: 'Top 1', reply_comment_total: 3, user: { unique_id: 'u1' } }),
    normalizeComment({ cid: '2', text: 'Top 2', reply_comment_total: 1, user: { unique_id: 'u2' } }),
    normalizeComment({ cid: '3', text: 'Top 3', reply_comment_total: 0, user: { unique_id: 'u3' } }),
  ];
  const replies = [
    normalizeComment({ cid: '11', text: 'R1', reply_id: '1', user: { unique_id: 'r1' } }),
    normalizeComment({ cid: '12', text: 'R2', reply_id: '1', user: { unique_id: 'r2' } }),
    normalizeComment({ cid: '12', text: 'R2 dup', reply_id: '1', user: { unique_id: 'r2' } }),
    normalizeComment({ cid: '13', text: 'R3', reply_id: '1', user: { unique_id: 'r3' } }),
    normalizeComment({ cid: '21', text: 'R21', reply_id: '2', user: { unique_id: 'r4' } }),
    normalizeComment({ cid: '31', text: 'Orphan', reply_id: '3', user: { unique_id: 'r5' } }),
  ];

  const tree = buildCommentTree(top, replies, {
    maxComments: 2,
    includeReplies: true,
    maxRepliesPerComment: 2,
  });

  assert.equal(tree.length, 2);
  assert.equal(tree[0].comment_id, '1');
  assert.equal(tree[0]._type, undefined);
  assert.equal(tree[0].reply_comments.length, 2);
  assert.deepEqual(tree[0].reply_comments.map((r) => r.comment_id), ['11', '12']);
  assert.equal(tree[0].reply_comments[0]._type, undefined);

  assert.equal(tree[1].comment_id, '2');
  assert.equal(tree[1].reply_comments.length, 1);
  assert.equal(tree[1].reply_comments[0].comment_id, '21');

  const noRepliesTree = buildCommentTree(top, replies, {
    maxComments: 2,
    includeReplies: false,
    maxRepliesPerComment: 2,
  });
  assert.deepEqual(noRepliesTree[0].reply_comments, []);
  assert.deepEqual(noRepliesTree[1].reply_comments, []);
});

test('setupInterceptors matches /api/comment/list/reply/ before /api/comment/list/ and supports cleanup()', async () => {
  const page = new EventEmitter();
  const capturedItems = [];
  const capturedRaw = [];
  const errors = [];

  const { cleanup } = setupInterceptors(page, {
    // Deliberately pass shorter endpoint first to verify specificity sorting
    endpoints: [ENDPOINTS.COMMENT_LIST, ENDPOINTS.COMMENT_REPLY_LIST, ENDPOINTS.ITEM_DETAIL],
    onItem: (item) => capturedItems.push(item),
    onRaw: (raw) => capturedRaw.push(raw),
    onError: (err) => errors.push(err),
  });

  page.emit(
    'response',
    makeResponse(
      'https://www.tiktok.com/api/comment/list/reply/?comment_id=500&cursor=0',
      { status_code: 0, has_more: 0, comments: [{ cid: '501', text: 'Nested reply', user: { unique_id: 'bob' } }] }
    )
  );
  page.emit(
    'response',
    makeResponse(
      'https://www.tiktok.com/api/item/detail/?itemId=777',
      {
        status_code: 0,
        itemInfo: {
          itemStruct: {
            id: '777',
            desc: 'Video title',
            createTime: 1700000000,
            locationCreated: 'ID',
            author: { id: 'a1', uniqueId: 'creator', nickname: 'Creator' },
            stats: { diggCount: 10, commentCount: 2, shareCount: 1, playCount: 100 },
          },
        },
      }
    )
  );
  page.emit(
    'response',
    makeResponse('https://www.tiktok.com/api/comment/list/?aweme_id=777', { status_code: 10000 })
  );
  page.emit(
    'response',
    makeResponse('https://www.tiktok.com/api/comment/list/?aweme_id=777', { status_code: 10101 })
  );

  await new Promise((r) => setTimeout(r, 20));

  assert.equal(capturedRaw[0].endpoint, ENDPOINTS.COMMENT_REPLY_LIST);
  assert.equal(capturedItems[0].is_reply, true);
  assert.equal(capturedItems[0].reply_id, '500');

  assert.equal(capturedItems[1]._type, 'video_detail');
  assert.equal(capturedItems[1].post_id, '777');
  assert.equal(capturedItems[1].location_created, 'ID');

  assert.equal(errors.length, 2);
  assert.ok(errors[0] instanceof CaptchaError);
  assert.ok(errors[1] instanceof RateLimitError);

  // Detach listener and confirm no further items are captured
  cleanup();
  page.emit(
    'response',
    makeResponse('https://www.tiktok.com/api/comment/list/?aweme_id=777', {
      status_code: 0,
      comments: [{ cid: '999', text: 'Should not be captured' }],
    })
  );
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(capturedItems.length, 2);
});

test('parseVideoQuery handles full video/photo URLs, short URLs, and bare IDs', () => {
  assert.deepEqual(
    parseVideoQuery('https://www.tiktok.com/@creator/video/7123456789012345678?is_from_webapp=1'),
    {
      url: 'https://www.tiktok.com/@creator/video/7123456789012345678?is_from_webapp=1',
      username: 'creator',
      videoId: '7123456789012345678',
    }
  );

  assert.deepEqual(
    parseVideoQuery('https://www.tiktok.com/@creator/photo/7123456789012345678'),
    {
      url: 'https://www.tiktok.com/@creator/photo/7123456789012345678',
      username: 'creator',
      videoId: '7123456789012345678',
    }
  );

  assert.deepEqual(
    parseVideoQuery('https://vt.tiktok.com/ZS2abcXYZ/'),
    {
      url: 'https://vt.tiktok.com/ZS2abcXYZ/',
      username: null,
      videoId: null,
    }
  );

  assert.deepEqual(
    parseVideoQuery('7123456789012345678'),
    {
      url: 'https://www.tiktok.com/video/7123456789012345678',
      username: null,
      videoId: '7123456789012345678',
    }
  );

  assert.throws(() => parseVideoQuery('https://example.com/video/123'), /Unsupported host/);
  assert.throws(() => parseVideoQuery(''), /Empty video query/);
});

test('scrapeVideoPage paginates comments, expands nested replies, extracts location_created, and detaches listeners', async () => {
  const page = new EventEmitter();
  let scrollCalls = 0;
  let replyClicks = 0;
  let currentUrl = 'https://www.tiktok.com/@creator/video/7123456789012345678';

  page.url = () => currentUrl;
  page.waitForTimeout = async () => {};
  page.goto = async (url) => {
    currentUrl = url;
    // Emit initial video detail + first page of top-level comments
    page.emit(
      'response',
      makeResponse('https://www.tiktok.com/api/item/detail/?itemId=7123456789012345678', {
        status_code: 0,
        itemInfo: {
          itemStruct: {
            id: '7123456789012345678',
            desc: 'Test video',
            createTime: 1700000000,
            locationCreated: 'ID',
            author: { id: 'u0', uniqueId: 'creator', nickname: 'Creator' },
            stats: { diggCount: 100, commentCount: 3, shareCount: 5, playCount: 1000 },
          },
        },
      })
    );
    page.emit(
      'response',
      makeResponse('https://www.tiktok.com/api/comment/list/?aweme_id=7123456789012345678&cursor=0', {
        status_code: 0,
        has_more: 1,
        comments: [
          {
            cid: 'c1',
            aweme_id: '7123456789012345678',
            text: 'First comment',
            create_time: 1700000100,
            digg_count: 10,
            reply_comment_total: 2,
            user: { uid: 'u1', unique_id: 'alice', nickname: 'Alice' },
          },
        ],
      })
    );
  };

  page.$ = async (selector) => {
    if (selector.startsWith('[data-scraper-btn=')) {
      return {
        scrollIntoViewIfNeeded: async () => {},
        click: async () => {
          replyClicks += 1;
          if (replyClicks === 1) {
            page.emit(
              'response',
              makeResponse('https://www.tiktok.com/api/comment/list/reply/?comment_id=c1&cursor=0', {
                status_code: 0,
                has_more: 1,
                comments: [
                  {
                    cid: 'r1',
                    aweme_id: '7123456789012345678',
                    text: 'Reply 1 to c1',
                    reply_id: 'c1',
                    user: { uid: 'u3', unique_id: 'charlie', nickname: 'Charlie' },
                  },
                ],
              })
            );
          } else if (replyClicks === 2) {
            page.emit(
              'response',
              makeResponse('https://www.tiktok.com/api/comment/list/reply/?comment_id=c1&cursor=1', {
                status_code: 0,
                has_more: 0,
                comments: [
                  {
                    cid: 'r2',
                    aweme_id: '7123456789012345678',
                    text: 'Reply 2 to c1',
                    reply_id: 'c1',
                    user: { uid: 'u4', unique_id: 'dana', nickname: 'Dana' },
                  },
                ],
              })
            );
          }
        },
      };
    }
    return null;
  };

  page.evaluate = async (fn, arg) => {
    // Distinguish scrollCommentsDown (no arg) vs findNextReplyExpander (arg with markerId) vs markExpanderExhausted
    if (arg && typeof arg === 'object' && 'markerId' in arg) {
      if (replyClicks < 2 && !(arg.exhausted || []).includes('First comment')) {
        return {
          markerId: arg.markerId,
          commentText: 'First comment',
          label: replyClicks === 0 ? 'View 2 replies' : 'View more',
          isLoadMore: replyClicks > 0,
        };
      }
      return null;
    }

    if (typeof arg === 'string') {
      return undefined;
    }

    // Scroll handler: emit second page of top-level comments
    scrollCalls += 1;
    if (scrollCalls === 1) {
      page.emit(
        'response',
        makeResponse('https://www.tiktok.com/api/comment/list/?aweme_id=7123456789012345678&cursor=20', {
          status_code: 0,
          has_more: 0,
          comments: [
            {
              cid: 'c2',
              aweme_id: '7123456789012345678',
              text: 'Second comment',
              create_time: 1700000200,
              digg_count: 5,
              reply_comment_total: 0,
              user: { uid: 'u2', unique_id: 'bob', nickname: 'Bob' },
            },
          ],
        })
      );
    }
    return undefined;
  };

  const result = await scrapeVideoPage(page, currentUrl, {
    extractVideo: true,
    includeComments: true,
    commentsPerPost: 10,
    includeReplies: true,
    repliesPerComment: 5,
    scrollDelay: 20,
    replyClickDelay: 0,
    replyResponseTimeout: 100,
    initialWaitMs: 50,
    skipCaptchaCheck: true,
    log: { info: () => {}, warning: () => {} },
  });

  assert.equal(result.video.post_id, '7123456789012345678');
  assert.equal(result.video.text, 'Test video');
  assert.equal(result.video.location_created, 'ID');
  assert.equal(result.comments.length, 2);
  assert.equal(result.stats.topLevelCount, 2);
  assert.equal(result.stats.replyCount, 2);
  assert.deepEqual(
    result.comments[0].reply_comments.map((r) => r.comment_id),
    ['r1', 'r2']
  );
  assert.deepEqual(result.comments[1].reply_comments, []);
  // Listener must be detached after scrapeVideoPage finishes
  assert.equal(page.listenerCount('response'), 0);
});

test('parseInput, buildUrl, and filterByOutputSchema support video mode and preserve location_created and comments in compat schema', async () => {
  const videoConfig = await parseInput({
    mode: 'video',
    queries: ['https://www.tiktok.com/@creator/video/7123456789012345678'],
    sessionCookies: VALID_COOKIES,
  });
  assert.equal(videoConfig.mode, 'video');
  assert.equal(videoConfig.includeComments, true);
  assert.equal(videoConfig.includeReplies, true);
  assert.equal(videoConfig.repliesPerComment, 10);
  assert.equal(videoConfig.maxVideosForComments, 10);
  assert.equal(
    buildUrl('video', '7123456789012345678'),
    'https://www.tiktok.com/video/7123456789012345678'
  );

  const explicitFalseConfig = await parseInput({
    mode: 'video',
    queries: ['7123456789012345678'],
    includeComments: false,
    sessionCookies: VALID_COOKIES,
  });
  assert.equal(explicitFalseConfig.includeComments, false);

  const itemWithComments = {
    post_id: '7123456789012345678',
    shortcode: '7123456789012345678',
    post_url: 'https://www.tiktok.com/@creator/video/7123456789012345678',
    text: 'Caption',
    timestamp: '2026-01-01T00:00:00.000Z',
    user: { username: 'creator' },
    likes: 10,
    replies: 2,
    reposts: 0,
    quotes: null,
    reshares: 1,
    views: 100,
    saves: 3,
    bookmarks: 3,
    images: [],
    videos: [],
    is_reply: false,
    source: 'api',
    location_created: 'ID',
    hashtags: [{ id: '1', name: 'fyp' }],
    comments: [
      {
        comment_id: 'c1',
        text: 'Nice!',
        reply_comments: [{ comment_id: 'r1', text: 'Thanks!', is_reply: true, reply_id: 'c1' }],
      },
    ],
  };

  const compat = filterByOutputSchema(itemWithComments, 'compat');
  assert.equal(compat.hashtags, undefined);
  assert.equal(compat.location_created, 'ID');
  assert.equal(compat.comments.length, 1);
  assert.equal(compat.comments[0].reply_comments[0].comment_id, 'r1');

  const itemWithoutComments = { ...itemWithComments };
  delete itemWithoutComments.comments;
  delete itemWithoutComments.location_created;
  const compatNoComments = filterByOutputSchema(itemWithoutComments, 'compat');
  assert.equal('comments' in compatNoComments, false);
  assert.equal(compatNoComments.location_created, null);
});
