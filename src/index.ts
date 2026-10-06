#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { XApiClient } from "./x-api.js";
import { resolveMediaInput } from "./media.js";
import { splitIntoTweets, weightedLength } from "./text.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. See .env.example for required variables.`);
  }
  return value;
}

const client = new XApiClient({
  apiKey: requireEnv("X_API_KEY"),
  apiSecret: requireEnv("X_API_SECRET"),
  accessToken: requireEnv("X_ACCESS_TOKEN"),
  accessTokenSecret: requireEnv("X_ACCESS_TOKEN_SECRET"),
  bearerToken: requireEnv("X_BEARER_TOKEN"),
  oauth2ClientId: process.env.X_OAUTH2_CLIENT_ID,
  oauth2ClientSecret: process.env.X_OAUTH2_CLIENT_SECRET,
});

const server = new McpServer({
  name: "x-mcp",
  version: "1.0.0",
});

// --- Helper to extract tweet ID from URL or raw ID ---
function parseTweetId(input: string): string {
  // Handle URLs like https://x.com/user/status/123456 or https://twitter.com/user/status/123456
  const match = input.match(/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/);
  if (match) return match[1];
  // Otherwise treat as raw ID
  const stripped = input.trim();
  if (/^\d+$/.test(stripped)) return stripped;
  throw new Error(`Invalid tweet ID or URL: ${input}`);
}

function formatResult(data: unknown, rateLimit: string): string {
  const output: Record<string, unknown> = { data };
  if (rateLimit) output.rate_limit = rateLimit;
  return JSON.stringify(output, null, 2);
}

// Upload each media_url (fetching the bytes server-side) and return the
// resulting media_ids, ready to attach to a post. Enforces X's per-post media
// rules: at most 4 items, and a video must be posted on its own.
async function uploadMediaUrls(urls: string[]): Promise<string[]> {
  if (urls.length > 4) {
    throw new Error("a post can attach at most 4 media items");
  }
  const mediaIds: string[] = [];
  for (const url of urls) {
    const { buffer, mimeType, category } = await resolveMediaInput({ media_url: url });
    if (category === "tweet_video" && urls.length > 1) {
      throw new Error("a video must be posted on its own (max 1 media item)");
    }
    const { mediaId } = await client.uploadMedia(buffer, mimeType, category);
    mediaIds.push(mediaId);
  }
  return mediaIds;
}

// Combine explicit media_ids with media_ids obtained by uploading media_urls.
async function resolveMediaIds(
  mediaIds: string[] | undefined,
  mediaUrls: string[] | undefined,
): Promise<string[] | undefined> {
  const ids = [...(mediaIds ?? [])];
  if (mediaUrls && mediaUrls.length > 0) {
    ids.push(...(await uploadMediaUrls(mediaUrls)));
  }
  return ids.length > 0 ? ids : undefined;
}

interface PublicMetrics {
  like_count?: number;
  retweet_count?: number;
  reply_count?: number;
  quote_count?: number;
  bookmark_count?: number;
  impression_count?: number;
}

// Summarize the engagement of a batch of the authenticated user's own posts.
function computeDigest(tweets: Array<{ id?: string; text?: string; created_at?: string; public_metrics?: PublicMetrics }>) {
  const scored = tweets.map((t) => {
    const m = t.public_metrics ?? {};
    const engagement =
      (m.like_count ?? 0) + (m.retweet_count ?? 0) + (m.reply_count ?? 0) + (m.quote_count ?? 0);
    return {
      id: t.id,
      preview: (t.text ?? "").replace(/\s+/g, " ").slice(0, 80),
      created_at: t.created_at,
      engagement,
      impressions: m.impression_count,
      metrics: m,
    };
  });
  const count = scored.length;
  const totalEngagement = scored.reduce((a, b) => a + b.engagement, 0);
  const totalImpressions = scored.reduce((a, b) => a + (b.impressions ?? 0), 0);

  const buckets = new Map<number, { sum: number; posts: number }>();
  for (const s of scored) {
    if (!s.created_at) continue;
    const hour = new Date(s.created_at).getUTCHours();
    const b = buckets.get(hour) ?? { sum: 0, posts: 0 };
    b.sum += s.engagement;
    b.posts += 1;
    buckets.set(hour, b);
  }
  const bestHours = [...buckets.entries()]
    .map(([hour, v]) => ({ hour_utc: hour, avg_engagement: Math.round((v.sum / v.posts) * 100) / 100, posts: v.posts }))
    .sort((a, b) => b.avg_engagement - a.avg_engagement)
    .slice(0, 3);

  const topPosts = [...scored].sort((a, b) => b.engagement - a.engagement).slice(0, 3);

  return {
    analyzed_posts: count,
    total_engagement: totalEngagement,
    avg_engagement: count ? Math.round((totalEngagement / count) * 100) / 100 : 0,
    engagement_rate: totalImpressions > 0 ? Math.round((totalEngagement / totalImpressions) * 10000) / 10000 : null,
    best_posting_hours_utc: bestHours,
    top_posts: topPosts,
  };
}

// ============================================================
// TWEET TOOLS
// ============================================================

server.tool(
  "post_tweet",
  "Create a new post on X (Twitter). Supports short posts and long-form articles (long posts are published automatically when the text exceeds 280 characters on eligible/Premium accounts), polls, and media attachments. Media can be attached either by media_id (from upload_media) or by passing media_urls, which are fetched and uploaded server-side so a video post completes in a single call.",
  {
    text: z.string().describe("The post text. Short posts and long-form (>280 char) posts are both supported."),
    poll_options: z.array(z.string()).optional().describe("Poll options (2-4 choices)"),
    poll_duration_minutes: z.number().optional().describe("Poll duration in minutes (default 1440 = 24h)"),
    media_ids: z.array(z.string()).optional().describe("Media IDs to attach (from upload_media)"),
    media_urls: z.array(z.string()).optional().describe("Up to 4 https media URLs to fetch and attach directly (a video must be the only attachment). Combined with media_ids if both are given."),
  },
  async ({ text, poll_options, poll_duration_minutes, media_ids, media_urls }) => {
    try {
      const resolvedMediaIds = await resolveMediaIds(media_ids, media_urls);
      const { result, rateLimit } = await client.postTweet({
        text,
        poll_options,
        poll_duration_minutes,
        media_ids: resolvedMediaIds,
      });
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "reply_to_tweet",
  "Reply to an existing post on X. Provide the tweet ID or URL to reply to. NOTE: As of Feb 2026, X restricts programmatic replies on all self-serve tiers (Free, Basic, Pro, Pay-Per-Use) -- you can only reply if the original author @mentions you or quotes your post. Otherwise the API will return an error. Enterprise is exempt. Consider using quote_tweet as an alternative.",
  {
    tweet_id: z.string().describe("The tweet ID or URL to reply to"),
    text: z.string().describe("The reply text"),
    media_ids: z.array(z.string()).optional().describe("Media IDs to attach"),
    media_urls: z.array(z.string()).optional().describe("Up to 4 https media URLs to fetch and attach directly"),
  },
  async ({ tweet_id, text, media_ids, media_urls }) => {
    try {
      const id = parseTweetId(tweet_id);
      const { result, rateLimit } = await client.postTweet({
        text,
        reply_to: id,
        media_ids: await resolveMediaIds(media_ids, media_urls),
      });
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "quote_tweet",
  "Quote retweet a post on X. Adds your commentary above the quoted post.",
  {
    tweet_id: z.string().describe("The tweet ID or URL to quote"),
    text: z.string().describe("Your commentary text"),
    media_ids: z.array(z.string()).optional().describe("Media IDs to attach"),
    media_urls: z.array(z.string()).optional().describe("Up to 4 https media URLs to fetch and attach directly"),
  },
  async ({ tweet_id, text, media_ids, media_urls }) => {
    try {
      const id = parseTweetId(tweet_id);
      const { result, rateLimit } = await client.postTweet({
        text,
        quote_tweet_id: id,
        media_ids: await resolveMediaIds(media_ids, media_urls),
      });
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "delete_tweet",
  "Delete a post on X by its ID.",
  {
    tweet_id: z.string().describe("The tweet ID or URL to delete"),
  },
  async ({ tweet_id }) => {
    try {
      const id = parseTweetId(tweet_id);
      const { result, rateLimit } = await client.deleteTweet(id);
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "get_tweet",
  "Fetch a tweet and its metadata by ID or URL. Returns author info, metrics, and referenced tweets.",
  {
    tweet_id: z.string().describe("The tweet ID or URL to fetch"),
  },
  async ({ tweet_id }) => {
    try {
      const id = parseTweetId(tweet_id);
      const { result, rateLimit } = await client.getTweet(id);
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

// ============================================================
// SEARCH
// ============================================================

server.tool(
  "search_tweets",
  "Search recent tweets by query. Supports keywords, hashtags, from:user, to:user, is:reply, has:media, etc. Uses the recent search endpoint (last 7 days).",
  {
    query: z.string().describe("Search query (e.g. 'from:elonmusk', '#ai', 'machine learning')"),
    max_results: z.number().optional().describe("Number of results (10-100, default 10)"),
    next_token: z.string().optional().describe("Pagination token from previous response"),
  },
  async ({ query, max_results, next_token }) => {
    try {
      const { result, rateLimit } = await client.searchTweets(query, max_results, next_token);
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

// ============================================================
// USER TOOLS
// ============================================================

server.tool(
  "get_user",
  "Look up a user profile by username or user ID. Returns bio, metrics, verification status, etc.",
  {
    username: z.string().optional().describe("Username (without @)"),
    user_id: z.string().optional().describe("Numeric user ID"),
  },
  async ({ username, user_id }) => {
    try {
      if (!username && !user_id) {
        return { content: [{ type: "text", text: "Error: Provide either username or user_id" }], isError: true };
      }
      const { result, rateLimit } = await client.getUser({ username, userId: user_id });
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "get_timeline",
  "Fetch a user's recent posts. Requires the user's numeric ID (use get_user first to resolve username to ID).",
  {
    user_id: z.string().describe("The numeric user ID"),
    max_results: z.number().optional().describe("Number of results (5-100, default 10)"),
    next_token: z.string().optional().describe("Pagination token from previous response"),
  },
  async ({ user_id, max_results, next_token }) => {
    try {
      const { result, rateLimit } = await client.getTimeline(user_id, max_results, next_token);
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "get_mentions",
  "Fetch recent mentions of the authenticated user.",
  {
    max_results: z.number().optional().describe("Number of results (5-100, default 10)"),
    next_token: z.string().optional().describe("Pagination token from previous response"),
  },
  async ({ max_results, next_token }) => {
    try {
      const { result, rateLimit } = await client.getMentions(max_results, next_token);
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "get_followers",
  "List followers of a user by their numeric user ID.",
  {
    user_id: z.string().describe("The numeric user ID"),
    max_results: z.number().optional().describe("Number of results (1-1000, default 100)"),
    next_token: z.string().optional().describe("Pagination token from previous response"),
  },
  async ({ user_id, max_results, next_token }) => {
    try {
      const { result, rateLimit } = await client.getFollowers(user_id, max_results, next_token);
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "get_following",
  "List who a user follows by their numeric user ID.",
  {
    user_id: z.string().describe("The numeric user ID"),
    max_results: z.number().optional().describe("Number of results (1-1000, default 100)"),
    next_token: z.string().optional().describe("Pagination token from previous response"),
  },
  async ({ user_id, max_results, next_token }) => {
    try {
      const { result, rateLimit } = await client.getFollowing(user_id, max_results, next_token);
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

// ============================================================
// ENGAGEMENT TOOLS
// ============================================================

server.tool(
  "like_tweet",
  "Like a post on X. NOTE: As of Aug 2025, this endpoint was removed from the Free API tier. Only works on paid tiers (Basic, Pro, Enterprise).",
  {
    tweet_id: z.string().describe("The tweet ID or URL to like"),
  },
  async ({ tweet_id }) => {
    try {
      const id = parseTweetId(tweet_id);
      const { result, rateLimit } = await client.likeTweet(id);
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "retweet",
  "Retweet a post on X.",
  {
    tweet_id: z.string().describe("The tweet ID or URL to retweet"),
  },
  async ({ tweet_id }) => {
    try {
      const id = parseTweetId(tweet_id);
      const { result, rateLimit } = await client.retweet(id);
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

// ============================================================
// BOOKMARKS (requires OAuth 2.0 -- run setup_oauth2 first)
// ============================================================

server.tool(
  "setup_oauth2",
  "One-time setup: Authorize OAuth 2.0 for bookmark access. Opens a browser for X login. Required before using get_bookmarks, bookmark_tweet, or unbookmark_tweet.",
  {},
  async () => {
    try {
      const message = await client.getOAuth2Manager().authorize();
      return { content: [{ type: "text", text: message }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "get_bookmarks",
  "Fetch the authenticated user's bookmarked posts. Returns tweets with author info and metrics.",
  {
    max_results: z.number().optional().describe("Number of results (1-100, default 10)"),
    next_token: z.string().optional().describe("Pagination token from previous response"),
  },
  async ({ max_results, next_token }) => {
    try {
      const { result, rateLimit } = await client.getBookmarks(max_results, next_token);
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "bookmark_tweet",
  "Bookmark a post on X.",
  {
    tweet_id: z.string().describe("The tweet ID or URL to bookmark"),
  },
  async ({ tweet_id }) => {
    try {
      const id = parseTweetId(tweet_id);
      const { result, rateLimit } = await client.bookmarkTweet(id);
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "unbookmark_tweet",
  "Remove a bookmark from a post on X.",
  {
    tweet_id: z.string().describe("The tweet ID or URL to unbookmark"),
  },
  async ({ tweet_id }) => {
    try {
      const id = parseTweetId(tweet_id);
      const { result, rateLimit } = await client.unbookmarkTweet(id);
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

// ============================================================
// MEDIA
// ============================================================

server.tool(
  "upload_media",
  "Upload an image, GIF, or video to X and return a media_id to attach to posts. Provide EITHER media_url (an https URL that is fetched and uploaded server-side) OR media_data (base64) together with mime_type. Videos and GIFs are processed asynchronously; this waits until processing succeeds before returning. Size limits: video 512MB, GIF 15MB, image 5MB.",
  {
    media_url: z.string().optional().describe("https URL of the media to fetch and upload (SSRF-protected: public hosts only)"),
    media_data: z.string().optional().describe("Base64-encoded media file data (requires mime_type)"),
    mime_type: z.string().optional().describe("MIME type (e.g. 'image/png', 'video/mp4'). Required with media_data; optional override for media_url."),
    media_category: z.string().optional().describe("Override category: 'tweet_image', 'tweet_gif', or 'tweet_video' (auto-detected from the MIME type by default)"),
  },
  async ({ media_url, media_data, mime_type, media_category }) => {
    try {
      const { buffer, mimeType, category } = await resolveMediaInput({
        media_url,
        media_data,
        mime_type,
        media_category,
      });
      const { mediaId, rateLimit } = await client.uploadMedia(buffer, mimeType, category);
      return {
        content: [{
          type: "text",
          text: formatResult({ media_id: mediaId, message: "Upload complete. Use this media_id in post_tweet." }, rateLimit),
        }],
      };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

// ============================================================
// METRICS
// ============================================================

server.tool(
  "get_metrics",
  "Get engagement metrics for a specific post (impressions, likes, retweets, replies, quotes, bookmarks). Requires the tweet to be authored by the authenticated user for non-public metrics.",
  {
    tweet_id: z.string().describe("The tweet ID or URL to get metrics for"),
  },
  async ({ tweet_id }) => {
    try {
      const id = parseTweetId(tweet_id);
      const { result, rateLimit } = await client.getTweetMetrics(id);
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

// ============================================================
// ENGAGEMENT (undo + relationships)
// ============================================================

server.tool(
  "unlike_tweet",
  "Remove a like from a post on X.",
  { tweet_id: z.string().describe("The tweet ID or URL to unlike") },
  async ({ tweet_id }) => {
    try {
      const { result, rateLimit } = await client.unlikeTweet(parseTweetId(tweet_id));
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "unretweet",
  "Undo a retweet of a post on X.",
  { tweet_id: z.string().describe("The tweet ID or URL to un-retweet") },
  async ({ tweet_id }) => {
    try {
      const { result, rateLimit } = await client.unretweet(parseTweetId(tweet_id));
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "follow_user",
  "Follow a user. Requires the target's numeric user ID (use get_user to resolve a username).",
  { user_id: z.string().describe("The numeric user ID to follow") },
  async ({ user_id }) => {
    try {
      const { result, rateLimit } = await client.followUser(user_id);
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "unfollow_user",
  "Unfollow a user by their numeric user ID.",
  { user_id: z.string().describe("The numeric user ID to unfollow") },
  async ({ user_id }) => {
    try {
      const { result, rateLimit } = await client.unfollowUser(user_id);
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "mute_user",
  "Mute a user by their numeric user ID.",
  { user_id: z.string().describe("The numeric user ID to mute") },
  async ({ user_id }) => {
    try {
      const { result, rateLimit } = await client.muteUser(user_id);
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "unmute_user",
  "Unmute a user by their numeric user ID.",
  { user_id: z.string().describe("The numeric user ID to unmute") },
  async ({ user_id }) => {
    try {
      const { result, rateLimit } = await client.unmuteUser(user_id);
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "block_user",
  "Block a user by their numeric user ID.",
  { user_id: z.string().describe("The numeric user ID to block") },
  async ({ user_id }) => {
    try {
      const { result, rateLimit } = await client.blockUser(user_id);
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "unblock_user",
  "Unblock a user by their numeric user ID.",
  { user_id: z.string().describe("The numeric user ID to unblock") },
  async ({ user_id }) => {
    try {
      const { result, rateLimit } = await client.unblockUser(user_id);
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "hide_reply",
  "Hide or unhide a reply to one of your posts.",
  {
    tweet_id: z.string().describe("The reply's tweet ID or URL"),
    hidden: z.boolean().optional().describe("true to hide (default), false to unhide"),
  },
  async ({ tweet_id, hidden }) => {
    try {
      const { result, rateLimit } = await client.hideReply(parseTweetId(tweet_id), hidden ?? true);
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

// ============================================================
// RETRIEVAL
// ============================================================

server.tool(
  "get_home_timeline",
  "Fetch the authenticated user's home timeline (reverse chronological) -- the posts from accounts they follow.",
  {
    max_results: z.number().optional().describe("Number of results (5-100, default 10)"),
    next_token: z.string().optional().describe("Pagination token from previous response"),
  },
  async ({ max_results, next_token }) => {
    try {
      const { result, rateLimit } = await client.getHomeTimeline(max_results, next_token);
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "get_liked_tweets",
  "List the posts a user has liked, by their numeric user ID.",
  {
    user_id: z.string().describe("The numeric user ID"),
    max_results: z.number().optional().describe("Number of results (5-100, default 10)"),
    next_token: z.string().optional().describe("Pagination token from previous response"),
  },
  async ({ user_id, max_results, next_token }) => {
    try {
      const { result, rateLimit } = await client.getLikedTweets(user_id, max_results, next_token);
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "get_retweeters",
  "List the users who retweeted a given post.",
  {
    tweet_id: z.string().describe("The tweet ID or URL"),
    max_results: z.number().optional().describe("Number of results (1-100, default 100)"),
    next_token: z.string().optional().describe("Pagination token from previous response"),
  },
  async ({ tweet_id, max_results, next_token }) => {
    try {
      const { result, rateLimit } = await client.getRetweeters(parseTweetId(tweet_id), max_results, next_token);
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  "get_quote_tweets",
  "List quote posts of a given post.",
  {
    tweet_id: z.string().describe("The tweet ID or URL"),
    max_results: z.number().optional().describe("Number of results (10-100, default 10)"),
    next_token: z.string().optional().describe("Pagination token from previous response"),
  },
  async ({ tweet_id, max_results, next_token }) => {
    try {
      const { result, rateLimit } = await client.getQuoteTweets(parseTweetId(tweet_id), max_results, next_token);
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

// ============================================================
// DIRECT MESSAGES
// ============================================================

server.tool(
  "send_dm",
  "Send a direct message to a user. Requires the recipient's numeric user ID (use get_user to resolve a username). Needs dm.write permission on the app's access token.",
  {
    user_id: z.string().describe("The recipient's numeric user ID"),
    text: z.string().describe("The message text"),
  },
  async ({ user_id, text }) => {
    try {
      const { result, rateLimit } = await client.sendDirectMessage(user_id, text);
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

// ============================================================
// THREADS & COMPOSING
// ============================================================

server.tool(
  "post_thread",
  "Post a thread (a chain of self-replies). Provide either `texts` (each item becomes one post) or a single long `text` that is auto-split into <=280-weighted-char posts at sentence/word boundaries (never cutting a URL). Returns every posted tweet id/URL. If a post fails mid-thread, the posts made so far are returned with the error.",
  {
    text: z.string().optional().describe("A long post to auto-split into a thread"),
    texts: z.array(z.string()).optional().describe("Explicit list of posts, one per item (overrides text)"),
    media_urls: z.array(z.string()).optional().describe("Up to 4 https media URLs attached to the FIRST post of the thread"),
    number_tweets: z.boolean().optional().describe("Append ' (i/n)' to each post (default false)"),
  },
  async ({ text, texts, media_urls, number_tweets }) => {
    const posted: Array<{ index: number; id?: string; url?: string }> = [];
    try {
      let segments = texts && texts.length > 0
        ? texts
        : text
          ? splitIntoTweets(text, number_tweets ? 270 : 280)
          : [];
      if (segments.length === 0) {
        throw new Error("provide either texts[] or text");
      }
      if (number_tweets) {
        const n = segments.length;
        segments = segments.map((s, i) => `${s} (${i + 1}/${n})`);
      }
      // Validate up front so we never post a partial thread with a doomed segment.
      segments.forEach((s, i) => {
        const { length } = weightedLength(s);
        if (length > 280) {
          throw new Error(`segment ${i + 1} is ${length} weighted chars (>280); shorten it or use \`text\` for auto-split`);
        }
      });

      const firstMediaIds = await resolveMediaIds(undefined, media_urls);
      let replyTo: string | undefined;
      for (let i = 0; i < segments.length; i++) {
        const { result } = await client.postTweet({
          text: segments[i],
          reply_to: replyTo,
          media_ids: i === 0 ? firstMediaIds : undefined,
        });
        const id = (result as { data?: { id?: string } })?.data?.id;
        posted.push({ index: i, id, url: id ? `https://x.com/i/web/status/${id}` : undefined });
        if (!id) throw new Error(`thread stopped at post ${i + 1}: no tweet id returned`);
        replyTo = id;
      }
      return { content: [{ type: "text", text: formatResult({ thread: posted, count: posted.length }, "") }] };
    } catch (e: unknown) {
      return {
        content: [{ type: "text", text: `Error: ${(e as Error).message}\nPosted so far: ${JSON.stringify(posted)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "preview_post",
  "Check a post before sending it: computes X's weighted character count (URLs = 23, most CJK/emoji = 2) and flags problems. No post is created. Use this to avoid 403s from over-length text.",
  {
    text: z.string().describe("The post text to measure"),
    media_count: z.number().optional().describe("How many media items you plan to attach"),
    has_poll: z.boolean().optional().describe("Whether the post will include a poll"),
  },
  async ({ text, media_count, has_poll }) => {
    const { length, urlCount } = weightedLength(text);
    const limit = 280;
    const warnings: string[] = [];
    if (length > limit) warnings.push(`text is ${length - limit} weighted characters over the ${limit} limit`);
    if ((media_count ?? 0) > 4) warnings.push("a post can attach at most 4 media items");
    if (has_poll && (media_count ?? 0) > 0) warnings.push("a post cannot have both a poll and media");
    return {
      content: [{
        type: "text",
        text: formatResult({
          weighted_length: length,
          limit,
          remaining: limit - length,
          over_limit: length > limit,
          url_count: urlCount,
          would_need_thread: length > limit,
          thread_post_count: splitIntoTweets(text).length,
          warnings,
        }, ""),
      }],
    };
  },
);

// ============================================================
// CONVERSATIONS
// ============================================================

server.tool(
  "get_conversation",
  "Fetch a whole thread/conversation from any tweet in it: returns the root post and the replies in time order (replies come from recent search, last ~7 days). Useful for reading full context before replying or summarizing.",
  {
    tweet_id: z.string().describe("Any tweet ID or URL in the conversation"),
    max_results: z.number().optional().describe("Max replies to fetch (10-100, default 50)"),
  },
  async ({ tweet_id, max_results }) => {
    try {
      const { result, rateLimit } = await client.getConversation(parseTweetId(tweet_id), max_results ?? 50);
      return { content: [{ type: "text", text: formatResult(result, rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

// ============================================================
// ANALYTICS DIGEST
// ============================================================

server.tool(
  "get_analytics_digest",
  "Summarize the performance of your recent posts in one call: total/average engagement, engagement rate (when impressions are available), best posting hours (UTC), and your top posts.",
  {
    max_results: z.number().optional().describe("How many recent posts to analyze (5-100, default 20)"),
  },
  async ({ max_results }) => {
    try {
      const userId = await client.getAuthenticatedUserId();
      const { result, rateLimit } = await client.getTimeline(
        userId,
        Math.min(Math.max(max_results ?? 20, 5), 100),
      );
      const tweets = (result as { data?: Array<{ id?: string; text?: string; created_at?: string; public_metrics?: PublicMetrics }> })?.data ?? [];
      return { content: [{ type: "text", text: formatResult(computeDigest(tweets), rateLimit) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

// ============================================================
// START SERVER
// ============================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
