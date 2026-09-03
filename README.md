# TikTok Scraper Actor

An Apify actor that scrapes TikTok data using session cookies and network interception. No DOM parsing required — data is captured directly from TikTok's internal API.

## Features

- **Network Interception**: Captures responses from TikTok's API endpoints without parsing HTML
- **Session Cookie Support**: Accepts cookies in multiple formats (raw header, JSON array, Netscape cookies.txt)
- **Multiple Modes**: Search, hashtag, and profile scraping
- **Efficient Resource Usage**: Blocks heavy resources (images, media, fonts) while keeping CSS for proper scroll behavior
- **Anti-Bot Handling**: Captcha detection, exponential backoff, and session rotation
- **Deduplication**: Automatic deduplication by item ID
- **Flexible Output**: Compat (Threads-style), native (full TikTok data), or both

## Input

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | string | `search` | Scraping mode: `search`, `hashtag`, or `profile` |
| `queries` | array | `[]` | List of search queries, hashtags (#), or usernames (@) |
| `maxItems` | integer | `200` | Maximum items per query |
| `sessionCookies` | string | `""` | Session cookies (raw header, JSON, or cookies.txt) |
| `cookiePool` | array | `[]` | Multiple cookie sets for rotation |
| `sortBy` | string | `relevance` | Sort order: `relevance` or `latest` |
| `publishedWithin` | string | `all` | Time filter: `all`, `1d`, `7d`, `30d`, `90d`, `180d` |
| `includeComments` | boolean | `false` | Whether to scrape comments |
| `commentsPerPost` | integer | `20` | Max comments per video |
| `downloadMedia` | boolean | `false` | Download media to KV store |
| `outputSchema` | string | `compat` | Output format: `compat`, `native`, or `both` |

### Cookie Format

Cookies can be provided in any of these formats:

1. **Raw Cookie header** (copy from browser DevTools):
   ```
   sessionid=abc123; sessionid_ss=abc123; sid_tt=xyz789; sid_guard=xyz789; msToken=...
   ```

2. **JSON array** (EditThisCookie/Playwright format):
   ```json
   [{"name": "sessionid", "value": "abc123", "domain": ".tiktok.com"}, ...]
   ```

3. **Netscape cookies.txt**:
   ```
   # Netscape HTTP Cookie File
   .tiktok.com	TRUE	/	TRUE	1234567890	sessionid	abc123
   ```

### Required Cookies

At minimum, these cookies must be present:
- `sessionid`
- `sessionid_ss`
- `sid_tt`
- `sid_guard`

Additional cookies that improve results:
- `ttwid`, `msToken`, `tt-target-idc`, `uid_tt`

## Output Schema

Each item in the dataset includes:

```json
{
  "post_id": "7123456789012345678",
  "shortcode": "7123456789012345678",
  "post_url": "https://www.tiktok.com/@username/video/7123456789012345678",
  "text": "Video caption text...",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "user": {
    "user_id": "1234567890",
    "username": "username",
    "full_name": "Display Name",
    "profile_url": "https://www.tiktok.com/@username",
    "profile_pic_url": "https://p16-sign.tiktokcdn.com/...",
    "is_verified": true,
    "follower_count": 100000
  },
  "likes": 50000,
  "replies": 1200,
  "reposts": 500,
  "quotes": null,
  "reshares": 3000,
  "views": 500000,
  "images": [],
  "videos": [{"url": "https://v16-webapp.tiktok.com/...", "duration": 30}],
  "is_reply": false,
  "source": "api",
  "hashtags": [{"id": "123", "name": "fyp"}],
  "mentions": [],
  "music": {"id": "123", "title": "Original Sound", "author": "Creator", "is_original": true},
  "video_duration": 30,
  "video_width": 1080,
  "video_height": 1920,
  "is_ad": false,
  "region": "US",
  "engagement_rate": 10.5
}
```

## Usage

### On Apify Platform

1. Create a new actor on [Apify Console](https://console.apify.com)
2. Set the build to use the Dockerfile
3. Configure input:
   ```json
   {
     "mode": "search",
     "queries": ["SamsungGalaxyS25Ultra"],
     "maxItems": 100,
     "sessionCookies": "sessionid=...; sessionid_ss=...; sid_tt=...; sid_guard=..."
   }
   ```

### Locally

```bash
# Install dependencies
npm install

# Run with input
npm start -- --input '{"queries":["fyp"],"sessionCookies":"..."}'
```

### With Apify CLI

```bash
apify login
apify create tiktok-scraper --template project_empty
# Copy files to the new project
cd tiktok-scraper
apify run
```

## Architecture

```
src/
  main.js              # Actor entry point, input validation, crawler setup
  cookies.js           # Cookie parsing/normalization/validation
  intercept.js         # Network response interception + endpoint routing
  paginate.js          # Scroll-based pagination with stall detection
  antibot.js           # Captcha detection, backoff, session rotation
  normalize/
    shared.js          # Shared video item normalization
    searchItem.js      # Search endpoint normalizers
    challengeItem.js   # Hashtag/challenge normalizer
    comment.js         # Comment normalizer
```

## How It Works

1. **Browser Launch**: Playwright launches a headless Chrome instance
2. **Cookie Injection**: Session cookies are injected into the browser context
3. **Resource Blocking**: Heavy resources (images, media, fonts) are blocked to reduce bandwidth
4. **Navigation**: The page navigates to TikTok search/hashtag/profile URL
5. **Network Interception**: Responses from TikTok API endpoints are intercepted
6. **Scroll Pagination**: The page scrolls to trigger infinite scroll, loading more results
7. **Normalization**: Raw API responses are normalized to the output schema
8. **Dataset Output**: Items are pushed to the Apify dataset

## Known Limitations

- **Search depth**: ~300-450 items max per query due to TikTok's internal limits
- **Media URLs**: Video URLs expire in ~2 hours; download during the run if needed
- **Personalization**: Results are personalized per account (logged-in vs anonymous differ)
- **Account risk**: Heavy scraping may rate-limit or ban the account; use throwaway accounts

## Cost Optimization

- Resource blocking reduces bandwidth by ~90%
- Network interception avoids DOM parsing overhead
- Session rotation distributes load across multiple accounts
- Configurable max items and pagination limits

## License

ISC
