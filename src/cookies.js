import crypto from 'crypto';

/**
 * Parse cookies from various formats into Playwright-compatible cookie array.
 * Supports: raw Cookie header string, EditThisCookie/Playwright JSON array, Netscape cookies.txt
 */

// Cookies that matter for TikTok authentication
const ESSENTIAL_COOKIES = ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard'];

/**
 * Parse raw Cookie header string into cookie array
 */
function parseCookieHeader(headerString) {
  return headerString
    .split(';')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) return null;
      return {
        name: pair.slice(0, eqIdx).trim(),
        value: pair.slice(eqIdx + 1).trim(),
        domain: '.tiktok.com',
        path: '/',
      };
    })
    .filter(Boolean);
}

/**
 * Parse Netscape cookies.txt format
 */
function parseNetscapeCookies(txt) {
  return txt
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const parts = line.split('\t');
      if (parts.length < 7) return null;
      const [domain, flag, path, secure, expires, name, value] = parts;
      return {
        name,
        value,
        domain: domain.startsWith('.') ? domain : `.${domain}`,
        path: path || '/',
        secure: secure === 'TRUE',
        expires: parseInt(expires, 10) || undefined,
      };
    })
    .filter(Boolean);
}

/**
 * Normalize cookies from any supported format into Playwright cookie array
 */
export function normalizeCookies(cookieInput) {
  if (Array.isArray(cookieInput)) {
    // Already in Playwright/EditThisCookie JSON format
    return cookieInput.map((c) => ({
      ...c,
      domain: c.domain || '.tiktok.com',
      path: c.path || '/',
    }));
  }

  if (typeof cookieInput === 'string') {
    const trimmed = cookieInput.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      // JSON string
      try {
        const parsed = JSON.parse(trimmed);
        return normalizeCookies(parsed);
      } catch {
        // Fall through to header parsing
      }
    }
    if (trimmed.includes('\t') && trimmed.includes('HttpOnly')) {
      // Likely Netscape cookies.txt
      return parseNetscapeCookies(trimmed);
    }
    // Assume raw Cookie header string
    return parseCookieHeader(trimmed);
  }

  throw new Error('Invalid cookie format. Expected string or array.');
}

/**
 * Validate that essential cookies are present
 */
export function validateCookies(cookies) {
  if (!cookies || cookies.length === 0) {
    return { valid: false, missing: ESSENTIAL_COOKIES, reason: 'No cookies provided' };
  }

  const names = cookies.map((c) => c.name.toLowerCase());
  const missing = ESSENTIAL_COOKIES.filter(
    (name) => !names.includes(name.toLowerCase())
  );

  if (missing.length > 0) {
    return {
      valid: false,
      missing,
      reason: `Missing essential cookies: ${missing.join(', ')}`,
    };
  }

  return { valid: true, missing: [], reason: '' };
}

/**
 * Generate a hash for a cookie set to use as a session identifier
 */
export function getCookieHash(cookies) {
  const sorted = [...cookies].sort((a, b) => a.name.localeCompare(b.name));
  const data = sorted.map((c) => `${c.name}=${c.value}`).join(';');
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
}

/**
 * Extract the target IDC from cookies (determines proxy region)
 */
export function getTargetIdc(cookies) {
  const idc = cookies.find(
    (c) => c.name.toLowerCase() === 'tt-target-idc'
  );
  return idc ? idc.value : null;
}

/**
 * Serialize cookies back to string format for storage
 */
export function serializeCookies(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * Parse cookies string from Apify input (handles multiple formats)
 */
export function parseInputCookies(cookieInput) {
  if (!cookieInput) return [];
  return normalizeCookies(cookieInput);
}
