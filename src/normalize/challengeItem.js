/**
 * normalize/challengeItem.js — Normalizer for /api/challenge/item_list/ (hashtag feed)
 *
 * Hashtag-based search returns items in a flat array with cursor-based pagination.
 */

import { normalizeVideoItem } from './shared.js';

/**
 * Normalize challenge/hashtag feed response
 */
export function normalizeChallengeItem(data, seenIds) {
  const items = data.itemList || data.item_list || data.data || [];
  const results = [];

  for (const item of items) {
    if (!item || !item.id) continue;

    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);

    const normalized = normalizeVideoItem(item);
    if (normalized) {
      results.push(normalized);
    }
  }

  return results;
}
