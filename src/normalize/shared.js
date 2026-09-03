/**
 * normalize/shared.js — Shared normalization logic for all item types
 */

/**
 * Normalize a single video item from any TikTok API endpoint
 */
export function normalizeVideoItem(item) {
  if (!item || !item.id) return null;

  const author = item.author || item.authorInfo || {};
  const authorStats = item.authorStats || {};
  const stats = item.stats || item.statsV2 || {};
  const video = item.video || {};
  const music = item.music || {};
  const textExtra = item.textExtra || [];

  // Extract hashtags from textExtra
  const hashtags = textExtra
    .filter((t) => t.hashtagName || t.hashtagId)
    .map((t) => ({
      id: t.hashtagId || null,
      name: t.hashtagName || null,
    }));

  // Extract mentions from textExtra
  const mentions = textExtra
    .filter((t) => t.type === 0 && t.userName)
    .map((t) => ({
      user_id: t.userId || null,
      username: t.userName || null,
    }));

  // Get engagement counts
  const diggCount = parseInt(stats.diggCount || statsDig(stats, 'diggCount'), 10) || 0;
  const commentCount = parseInt(stats.commentCount || statsDig(stats, 'commentCount'), 10) || 0;
  const shareCount = parseInt(stats.shareCount || statsDig(stats, 'shareCount'), 10) || 0;
  const playCount = parseInt(stats.playCount || statsDig(stats, 'playCount'), 10) || 0;
  const repostCount = parseInt(stats.repostCount || statsDig(stats, 'repostCount'), 10) || 0;

  // Calculate engagement rate
  const engagementRate = playCount > 0
    ? ((diggCount + commentCount + shareCount + repostCount) / playCount * 100).toFixed(2)
    : null;

  return {
    post_id: item.id,
    shortcode: item.id,
    post_url: `https://www.tiktok.com/@${author.uniqueId || 'user'}/video/${item.id}`,
    text: item.desc || '',
    timestamp: item.createTime
      ? new Date(parseInt(item.createTime, 10) * 1000).toISOString()
      : null,
    user: {
      user_id: author.id || null,
      username: author.uniqueId || null,
      full_name: author.nickname || null,
      profile_url: `https://www.tiktok.com/@${author.uniqueId || ''}`,
      profile_pic_url: author.avatarLarger || author.avatarMedium || author.avatarThumb || null,
      is_verified: author.verified || false,
      follower_count: authorStats.followerCount || null,
    },
    likes: diggCount,
    replies: commentCount,
    reposts: repostCount,
    quotes: null,
    reshares: shareCount,
    views: playCount,
    images: item.imagePost?.images?.map((img) => img.imageURL?.urlList?.[0] || img.url) || [],
    videos: video.playAddr
      ? [{ url: video.playAddr, duration: video.duration || null }]
      : (video.downloadAddr ? [{ url: video.downloadAddr }] : []),
    is_reply: false,
    source: 'api',
    hashtags,
    mentions,
    music: music.id
      ? {
          id: music.id,
          title: music.title || null,
          author: music.authorName || null,
          is_original: music.original || false,
        }
      : null,
    video_duration: video.duration || null,
    video_width: video.width || null,
    video_height: video.height || null,
    is_ad: item.isAd || false,
    region: item.regionCode || item.region || null,
    engagement_rate: engagementRate ? parseFloat(engagementRate) : null,
  };
}

/**
 * Helper to extract stat value from statsV2
 */
export function statsDig(stats, key) {
  if (stats[`${key}Str`]) return stats[`${key}Str`];
  const str = stats[key];
  if (typeof str === 'string') return str;
  if (str && typeof str === 'object' && str.value) return str.value;
  return null;
}
