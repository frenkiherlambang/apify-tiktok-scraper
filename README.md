# TikTok Scraper Actor

An Apify actor that scrapes TikTok data using session cookies and network interception. No DOM parsing required — data is captured directly from TikTok's internal API.

## Features

- **Network Interception**: Captures responses from TikTok's API endpoints without parsing HTML
- **Session Cookie Support**: Accepts cookies in multiple formats (raw header, JSON array, Netscape cookies.txt)
- **Multiple Modes**: Search, hashtag, profile, and direct video URL scraping
- **Comments & Nested Replies**: Scrapes top-level comments (`/api/comment/list/`) and expands nested replies (`/api/comment/list/reply/`) into `video.comments -> comment.reply_comments`
- **Efficient Resource Usage**: Blocks heavy resources (images, media, fonts) while keeping CSS for proper scroll behavior
- **Anti-Bot Handling**: Captcha detection, exponential backoff, and session rotation
- **Deduplication**: Automatic deduplication by item ID
- **Flexible Output**: Compat (Threads-style), native (full TikTok data), or both

## Input

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | string | `search` | Scraping mode: `search`, `hashtag`, `profile`, or `video` |
| `queries` | array | `[]` | List of search queries, hashtags (#), usernames (@), or video URLs/IDs (`video` mode) |
| `maxItems` | integer | `200` | Maximum items per query |
| `sessionCookies` | string | `""` | Session cookies (raw header, JSON, or cookies.txt) |
| `cookiePool` | array | `[]` | Multiple cookie sets for rotation |
| `sortBy` | string | `relevance` | Sort order: `relevance` or `latest` |
| `publishedWithin` | string | `all` | Server-side time filter: `all`, `1d`, `7d`, `30d`, `90d`, `180d` |
| `dateFrom` | string | `""` | Keep posts published on/after this date (`YYYY-MM-DD` or ISO datetime). Client-side, all modes |
| `dateTo` | string | `""` | Keep posts published on/before this date (inclusive). Client-side, all modes |
| `language` | string | `id` | ISO language code (`id`, `en`, `ms`, `th`, `vi`, `ja`, `ko`, `es`, `pt`) |
| `includeComments` | boolean | `false` (`true` in `video` mode if omitted) | Whether to scrape comments for each video |
| `commentsPerPost` | integer | `20` | Max top-level comments per video (1–1000) |
| `includeReplies` | boolean | `true` | Expand and scrape nested replies under each comment when `includeComments` is enabled |
| `repliesPerComment` | integer | `10` | Max nested replies per top-level comment (1–200) |
| `maxVideosForComments` | integer | `10` | Max videos per feed query to scrape comments for (`0` = all scraped videos) |
| `downloadMedia` | boolean | `false` | Download media to KV store |
| `outputSchema` | string | `compat` | Output format: `compat`, `native`, or `both` (comments and `location_created` are preserved in all schemas) |
| `proxyConfiguration` | object | `{"useApifyProxy": false}` | Apify Proxy or custom external proxy configuration |

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

### Proxy Configuration

Proxies can be configured in two ways:

1. **Via Actor Input (`proxyConfiguration`)**:
   - In Apify UI, configure under the **Proxy** section (select Apify Residential/Datacenter proxy or provide custom external proxy URLs).
   - In JSON input:
     ```json
     "proxyConfiguration": {
       "useApifyProxy": false,
       "proxyUrls": ["http://username:password@proxy-host.com:8000"]
     }
     ```

2. **Via Environment Variables**:
   - Set `CUSTOM_PROXY_URL`, `PROXY_URL`, or `APIFY_PROXY_URL` in Actor Settings or local `.env`:
     ```bash
     CUSTOM_PROXY_URL="http://username:password@proxy-host.com:8000"
     ```
   - Multiple proxy endpoints can be comma-separated or newline-separated. When multiple proxies are passed, the scraper deterministically pins each session to a proxy using the cookie hash.

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
  "saves": 4500,
  "bookmarks": 4500,
  "images": [],
  "videos": [{"url": "https://v16-webapp.tiktok.com/...", "duration": 30}],
  "is_reply": false,
  "source": "api",
  "location_created": "ID",
  "comments": [
    {
      "comment_id": "7345678901234567890",
      "post_id": "7345678901234567890",
      "text": "Great video!",
      "timestamp": "2024-01-15T11:00:00.000Z",
      "user": {
        "user_id": "999",
        "username": "commenter",
        "full_name": "Commenter"
      },
      "likes": 42,
      "replies": 2,
      "sub_comment_count": 2,
      "is_reply": false,
      "aweme_id": "7123456789012345678",
      "reply_id": null,
      "reply_comments": [
        {
          "comment_id": "7345678901234567891",
          "post_id": "7345678901234567891",
          "text": "Agreed!",
          "timestamp": "2024-01-15T11:05:00.000Z",
          "likes": 5,
          "is_reply": true,
          "aweme_id": "7123456789012345678",
          "reply_id": "7345678901234567890",
          "reply_to_reply_id": null,
          "reply_to_username": "commenter"
        }
      ]
    }
  ]
}
```

## Usage

### On Apify Platform

1. Create a new actor on [Apify Console](https://console.apify.com)
2. Set the build to use the Dockerfile
3. Configure input (search or direct video comments):
   ```json
   {
     "mode": "video",
     "queries": ["https://www.tiktok.com/@username/video/7123456789012345678"],
     "includeComments": true,
     "commentsPerPost": 50,
     "includeReplies": true,
     "repliesPerComment": 10,
     "sessionCookies": "sessionid=...; sessionid_ss=...; sid_tt=...; sid_guard=..."
   }
   ```

### Locally

```bash
# Install dependencies
npm install

# Run unit tests
npm test

# Run actor
npm start
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
  paginate.js          # Scroll-based feed pagination with stall detection
  comments.js          # Video page metadata, comment pagination, and reply expansion
  antibot.js           # Captcha detection, backoff, session rotation
  normalize/
    shared.js          # Shared video item normalization
    searchItem.js      # Search endpoint normalizers
    challengeItem.js   # Hashtag/challenge normalizer
    comment.js         # Comment and nested reply normalizer + tree builder
```

## How It Works

1. **Browser Launch**: Crawlee's `PlaywrightCrawler` launches Camoufox, a stealth-patched Firefox build that spoofs fingerprints at the browser level
2. **Cookie Injection**: Session cookies are injected into the browser context
3. **Resource Blocking**: Heavy resources (images, media, fonts) are blocked to reduce bandwidth
4. **Navigation**: The page navigates to TikTok search, hashtag, profile, or video URL
5. **Network Interception**: Responses from TikTok API endpoints are intercepted
6. **Scroll Pagination & Reply Expansion**: Scrolls feeds/comment panels and clicks "View replies" buttons so TikTok's signed API requests load comments and nested replies
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
- Configurable max items, video comment caps, and pagination limits

## License

ISC
