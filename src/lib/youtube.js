/**
 * YouTube subscriber counts, for the badge beside a tournament's stream
 * link.
 *
 * WHY ONLY YOUTUBE. Of the platforms in STREAM_PLATFORMS, YouTube is the
 * only one that will tell an anonymous caller how many followers an
 * account has. Instagram has no public follower endpoint at all -- the
 * Graph API needs the account owner to authorise your app through
 * Facebook Login, per creator, which is an onboarding flow rather than a
 * URL field. Twitch and Kick each need their own token dance. So this
 * covers YouTube and everything else keeps its plain link; a badge that
 * appears for one platform and not another is honest, a badge that
 * silently shows a wrong number is not.
 *
 * TWO THINGS TO TELL A CREATOR UP FRONT:
 *   - YouTube rounds public subscriber counts to three significant
 *     figures. 1,234 subscribers is reported as 1,230. There is no way
 *     to get the exact number without the channel owner's OAuth.
 *   - A channel can hide its count entirely, in which case the API omits
 *     it and there is simply no badge.
 *
 * QUOTA. channels.list costs 1 unit against a 10,000/day default, and
 * results are cached for six hours, so a tournament page being opened a
 * thousand times costs one unit.
 */

const SUBS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;   // six hours

// A tournament page needs one lookup per DISTINCT channel per six hours.
// A platform with a hundred live tournaments spends well under a hundred
// units a day against a 10,000 default, so this ceiling is far above any
// honest usage and far below the quota.
const DEFAULT_MAX_LOOKUPS_PER_DAY = 500;

/**
 * Pull a channel reference out of a YouTube URL.
 *
 * Returns { type: 'id' | 'handle', value } or null.
 *
 * Only the two forms the API can resolve in ONE call are supported:
 *   youtube.com/channel/UC...   -> channels.list?id=
 *   youtube.com/@handle         -> channels.list?forHandle=
 *
 * The legacy /c/Name and /user/Name forms would need a search call, which
 * costs 100 quota units and can return the wrong channel. A link in one
 * of those shapes gets no badge rather than a guess.
 */
function parseYouTubeChannel(url) {
    const raw = String(url || '').trim();
    if (!raw) return null;

    let u;
    try {
        u = new URL(raw);
    } catch (e) {
        return null;
    }
    // http/https only, and only YouTube's own hosts -- this value comes
    // from an organizer-editable column.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'youtu.be') return null;

    const parts = u.pathname.split('/').filter(Boolean);
    if (!parts.length) return null;

    // /@handle
    if (parts[0].charAt(0) === '@') {
        const handle = parts[0].slice(1);
        return /^[A-Za-z0-9._-]{3,30}$/.test(handle) ? { type: 'handle', value: handle } : null;
    }
    // /channel/UC...
    if (parts[0].toLowerCase() === 'channel' && parts[1]) {
        return /^UC[A-Za-z0-9_-]{22}$/.test(parts[1]) ? { type: 'id', value: parts[1] } : null;
    }
    return null;
}

/**
 * Rounded the way YouTube itself displays it -- 1.23K, 45.6K, 1.2M.
 * Showing "1230" next to a channel that says "1.23K subscribers" reads
 * as a different number to the same person.
 */
function formatSubscribers(n) {
    const v = Number(n);
    if (!isFinite(v) || v < 0) return null;
    if (v < 1000) return String(v);

    // Rounded to three significant figures, then the unit is chosen from
    // the ROUNDED value. Choosing it first produced "1000K" for 999,999,
    // because the rounding rolled over after the unit was already fixed.
    const scale = (n, unit) => {
        const x = n < 100 ? Number(n.toFixed(n < 10 ? 2 : 1)) : Math.round(n);
        return { text: x + unit, rolled: x >= 1000 };
    };
    if (v < 1000000) {
        const k = scale(v / 1000, 'K');
        if (!k.rolled) return k.text;
    }
    const m = scale(v / 1000000, 'M');
    if (!m.rolled) return m.text;
    return scale(v / 1000000000, 'B').text;
}

/**
 * deps.fetchJson(url) -> parsed JSON or null. Injected so this is
 * testable without touching the network or holding a key.
 *
 * TWO GUARDS BEYOND THE CACHE, because the endpoint in front of this is
 * unauthenticated (the data is public, so requiring a login would only
 * stop the anonymous visitors the badge exists for):
 *
 *   IN-FLIGHT DEDUPE. The cache is only written once a fetch RESOLVES.
 *   Fifty people opening the same tournament page in the same second
 *   would otherwise all miss the cache and all call YouTube. Callers
 *   asking for a channel already being fetched wait on the same promise.
 *
 *   DAILY BUDGET. The cache bounds repeats, not VARIETY -- somebody
 *   passing a different channel URL every time gets a cache miss every
 *   time, and each miss is a quota unit. Once the day's budget is spent
 *   the answer is 'budget' and no call is made, so the worst case is a
 *   missing badge rather than a dead API key for every tournament on the
 *   platform.
 */
function createYouTubeStats(deps) {
    const d = deps || {};
    const apiKey = d.apiKey;
    const fetchJson = d.fetchJson;
    const now = d.now || (() => Date.now());
    const log = d.log || console.log;
    const maxPerDay = typeof d.maxPerDay === 'number' ? d.maxPerDay : DEFAULT_MAX_LOOKUPS_PER_DAY;

    // Per-instance, so one bot's budget is not shared with a test's.
    const cacheStore = d.cache || new Map();   // key -> { data, ts }
    const inFlight = new Map();                // key -> Promise
    let spent = 0;
    let dayStart = now();

    function budgetAvailable() {
        // Rolling 24h rather than a calendar day: no timezone to agree on
        // with Google, and the window can't be gamed by waiting for
        // midnight UTC.
        if (now() - dayStart >= 24 * 60 * 60 * 1000) { dayStart = now(); spent = 0; }
        return spent < maxPerDay;
    }

    function cache(key, data) {
        cacheStore.set(key, { data, ts: now() });
        return data;
    }

    async function fetchChannel(ref, key) {
        const param = ref.type === 'id'
            ? 'id=' + encodeURIComponent(ref.value)
            : 'forHandle=' + encodeURIComponent('@' + ref.value);
        const api = 'https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&'
                  + param + '&key=' + encodeURIComponent(apiKey);

        let json = null;
        try {
            spent++;
            json = await fetchJson(api);
        } catch (e) {
            // Never throws to the caller: a badge is decoration, and it
            // must not be able to fail the page it sits on. Not cached
            // either -- an outage should not blank the badge for six
            // hours after it ends.
            log('[youtube] fetch failed: ' + (e && e.message));
            return { ok: false, reason: 'unreachable' };
        }
        if (!json || !Array.isArray(json.items) || !json.items.length) {
            // Cached: a handle that does not resolve today will not
            // resolve on the next page load either, and re-asking costs a
            // quota unit each time.
            return cache(key, { ok: false, reason: 'not-found' });
        }

        const stats = json.items[0].statistics || {};
        // hiddenSubscriberCount, or the field simply absent: the channel
        // has chosen not to publish this. No badge, no invented number.
        if (stats.hiddenSubscriberCount === true || stats.subscriberCount === undefined) {
            return cache(key, { ok: false, reason: 'hidden' });
        }

        const count = Number(stats.subscriberCount);
        if (!isFinite(count)) return cache(key, { ok: false, reason: 'not-found' });

        return cache(key, {
            ok: true,
            subscribers: count,
            display: formatSubscribers(count),
            title: (json.items[0].snippet || {}).title || null
        });
    }

    async function subscribersFor(url) {
        const ref = parseYouTubeChannel(url);
        if (!ref) return { ok: false, reason: 'unsupported-url' };
        if (!apiKey) return { ok: false, reason: 'not-configured' };

        const key = ref.type + ':' + ref.value;
        const hit = cacheStore.get(key);
        if (hit && (now() - hit.ts) < SUBS_CACHE_TTL_MS) return hit.data;

        const already = inFlight.get(key);
        if (already) return already;

        // Checked AFTER the cache, so a spent budget still serves every
        // channel already known -- the tournaments actually running keep
        // their badges.
        if (!budgetAvailable()) return { ok: false, reason: 'budget' };

        const p = fetchChannel(ref, key).finally(() => inFlight.delete(key));
        inFlight.set(key, p);
        return p;
    }

    // For /health, so a spent budget is visible without reading logs.
    function status() {
        return { spentToday: spent, maxPerDay, cached: cacheStore.size, inFlight: inFlight.size };
    }

    return { subscribersFor, status };
}

module.exports = {
    parseYouTubeChannel, formatSubscribers, createYouTubeStats,
    SUBS_CACHE_TTL_MS, DEFAULT_MAX_LOOKUPS_PER_DAY
};
