import { getBlacklistKeywords } from "./db.js";

let cachedKeywords = null;
let cacheTime = 0;
const CACHE_TTL = 5000;

export function checkBlacklist(text) {
  if (!text) return { blacklisted: false, reason: null };

  const now = Date.now();
  if (!cachedKeywords || now - cacheTime > CACHE_TTL) {
    cachedKeywords = getBlacklistKeywords();
    cacheTime = now;
  }

  const lowerText = text.toLowerCase();
  for (const keyword of cachedKeywords) {
    if (lowerText.includes(keyword)) {
      return { blacklisted: true, reason: keyword };
    }
  }

  return { blacklisted: false, reason: null };
}

export function invalidateBlacklistCache() {
  cachedKeywords = null;
  cacheTime = 0;
}
