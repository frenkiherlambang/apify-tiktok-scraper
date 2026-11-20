/**
 * normalize/comment.js — Normalizer for /api/comment/list/ and /api/comment/list/reply/
 *
 * Maps TikTok's comment and reply API responses into structured comment objects
 * and builds the nested video -> comments -> reply_comments hierarchy.
 */

/**
 * Normalize a single comment or reply object from TikTok's API
 */
export function normalizeComment(comment, { forceReply = false } = {}) {
  if (!comment || !comment.cid) return null;

  const user = comment.user || {};
  const stats = comment.stats || {};
  const cid = String(comment.cid);
  const rawReplyId = comment.reply_id != null ? String(comment.reply_id) : null;
  const rawReplyToReplyId = comment.reply_to_reply_id != null ? String(comment.reply_to_reply_id) : null;

  const replyId = rawReplyId && rawReplyId !== '0' ? rawReplyId : null;
  const replyToReplyId = rawReplyToReplyId && rawReplyToReplyId !== '0' ? rawReplyToReplyId : null;
  const isReply = Boolean(forceReply || replyId);

  const replyTotal = Number(
    stats.reply_comment_total
    ?? comment.reply_comment_total
    ?? comment.sub_comment_count
    ?? 0
  ) || 0;

  const username = user.unique_id || user.uniqueId || null;
  const images = Array.isArray(comment.image_list)
    ? comment.image_list
      .map((img) => img?.origin_url?.url_list?.[0] || img?.crop_url?.url_list?.[0] || null)
      .filter(Boolean)
    : [];

  const normalized = {
    comment_id: cid,
    post_id: cid,
    shortcode: null,
    post_url: comment.share_info?.share_url || null,
    text: comment.text || '',
    timestamp: comment.create_time
      ? new Date(parseInt(comment.create_time, 10) * 1000).toISOString()
      : null,
    user: {
      user_id: user.uid || user.id ? String(user.uid || user.id) : null,
      username,
      full_name: user.nickname || null,
      profile_url: username ? `https://www.tiktok.com/@${username}` : null,
      profile_pic_url: user.avatar_thumb?.url_list?.[0]
        || (typeof user.avatar_thumb === 'string' ? user.avatar_thumb : null),
      is_verified: Boolean(user.custom_verify || user.verified),
      follower_count: user.follower_count ?? null,
    },
    likes: Number(stats.digg_count ?? comment.digg_count ?? 0) || 0,
    replies: replyTotal,
    reposts: null,
    quotes: null,
    reshares: null,
    views: null,
    images,
    videos: [],
    is_reply: isReply,
    source: 'api',
    _type: 'comment',
    aweme_id: comment.aweme_id ? String(comment.aweme_id) : null,
    reply_id: replyId,
    reply_to_reply_id: replyToReplyId,
    reply_to_username: comment.reply_to_username || null,
    sub_comment_count: replyTotal,
    is_pinned: Boolean(comment.author_pin),
    is_author_liked: Boolean(comment.is_author_digged),
  };

  if (!isReply) {
    normalized.reply_comments = [];
  }

  return normalized;
}

/**
 * Normalize /api/comment/list/ response.
 * Also extracts any inline preview replies TikTok includes under `comment.reply_comment`.
 */
export function normalizeCommentList(data, seenIds = new Set()) {
  const comments = data?.comments || data?.data || [];
  const results = [];

  for (const comment of comments) {
    if (!comment || !comment.cid) continue;
    const cid = String(comment.cid);

    if (!seenIds.has(cid)) {
      seenIds.add(cid);
      const normalized = normalizeComment(comment);
      if (normalized) {
        results.push(normalized);
      }
    }

    // TikTok occasionally includes inline preview replies in `reply_comment`
    if (Array.isArray(comment.reply_comment)) {
      for (const inlineReply of comment.reply_comment) {
        if (!inlineReply || !inlineReply.cid) continue;
        const replyCid = String(inlineReply.cid);
        if (seenIds.has(replyCid)) continue;
        seenIds.add(replyCid);

        const normalizedReply = normalizeComment(
          {
            ...inlineReply,
            reply_id: inlineReply.reply_id && String(inlineReply.reply_id) !== '0'
              ? inlineReply.reply_id
              : cid,
          },
          { forceReply: true }
        );
        if (normalizedReply) {
          results.push(normalizedReply);
        }
      }
    }
  }

  return results;
}

/**
 * Normalize /api/comment/list/reply/ response.
 */
export function normalizeCommentReplyList(data, seenIds = new Set(), fallbackParentId = null) {
  const comments = data?.comments || data?.data || [];
  const results = [];

  for (const comment of comments) {
    if (!comment || !comment.cid) continue;
    const cid = String(comment.cid);

    if (seenIds.has(cid)) continue;
    seenIds.add(cid);

    const withParent = (!comment.reply_id || String(comment.reply_id) === '0') && fallbackParentId
      ? { ...comment, reply_id: String(fallbackParentId) }
      : comment;

    const normalized = normalizeComment(withParent, { forceReply: true });
    if (normalized) {
      results.push(normalized);
    }
  }

  return results;
}

/**
 * Strip internal metadata keys from a comment/reply object before final output.
 */
function stripInternalFields(comment) {
  const { _type, ...clean } = comment;
  return clean;
}

/**
 * Assemble top-level comments and replies into the nested structure:
 *   comment -> reply_comments: [...]
 * Enforces maxComments and maxRepliesPerComment caps and deduplicates by comment_id.
 */
export function buildCommentTree(
  topComments,
  replies,
  { maxComments = 20, includeReplies = true, maxRepliesPerComment = 10 } = {}
) {
  const limitedTop = (topComments || []).slice(0, Math.max(0, maxComments));
  const byId = new Map();
  const seenReplyIdsByParent = new Map();
  const tree = [];

  for (const comment of limitedTop) {
    const clean = stripInternalFields(comment);
    clean.reply_comments = [];
    byId.set(clean.comment_id, clean);
    seenReplyIdsByParent.set(clean.comment_id, new Set());
    tree.push(clean);
  }

  if (!includeReplies || maxRepliesPerComment <= 0) {
    return tree;
  }

  for (const reply of replies || []) {
    if (!reply || !reply.reply_id) continue;
    const parent = byId.get(String(reply.reply_id));
    if (!parent) continue;

    const seenForParent = seenReplyIdsByParent.get(parent.comment_id);
    if (seenForParent.has(reply.comment_id)) continue;
    if (parent.reply_comments.length >= maxRepliesPerComment) continue;

    seenForParent.add(reply.comment_id);
    parent.reply_comments.push(stripInternalFields(reply));
  }

  return tree;
}
