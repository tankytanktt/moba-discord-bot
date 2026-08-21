/**
 * Read access to MSP for slash commands.
 *
 * Until now every path in this bot was OUTBOUND -- the website told the bot
 * to send a DM or post a broadcast. Nothing let a Discord user ask MSP a
 * question. This module is the inbound half.
 *
 * NOTE ON DUPLICATION: src/api/apiRouter.js has its own callRpcAsService().
 * They are deliberately not merged right now -- that file also carries the
 * Razorpay payment and webhook paths, and refactoring a shared dependency
 * out from under live money handling is not a change to make casually. If
 * they are ever unified, this is the copy to keep and apiRouter should
 * delegate to it, not the other way round.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Where to send people for the full picture. Overridable so a staging
// deploy links to staging rather than production.
//
// The default MUST be the real production host: every command falls back
// to a link when an RPC is unreachable, so a wrong default breaks exactly
// the path that runs when something is already going wrong. It was
// mobaesports.netlify.app for one deploy -- a guess, and the wrong one.
const SITE_URL = (process.env.SITE_URL || 'https://mobaesportsplatform.netlify.app').replace(/\/+$/, '');

/**
 * Calls a Postgres function with the service-role key.
 *
 * Every failure mode resolves to null rather than throwing. An async
 * discord.js interaction handler that rejects leaves the user staring at
 * "The application did not respond" with no explanation, and an unhandled
 * rejection can take the whole process down -- Discord connection included.
 * Callers check for null and say something useful instead.
 */
async function callRpc(fnName, args) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        console.error(`[mspApi] ${fnName}: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY`);
        return null;
    }
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apikey: SUPABASE_SERVICE_ROLE_KEY,
                Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
            },
            body: JSON.stringify(args || {})
        });
        if (!res.ok) {
            // Body, not just status: PostgREST puts the actual reason
            // (missing function, bad argument types) in the payload, and
            // without it every failure looks identical in the logs.
            let detail = '';
            try { detail = (await res.text()).slice(0, 300); } catch (e) { /* ignore */ }
            console.error(`[mspApi] ${fnName} -> HTTP ${res.status} ${detail}`);
            return null;
        }
        return await res.json();
    } catch (err) {
        console.error(`[mspApi] ${fnName} failed:`, err.message);
        return null;
    }
}

/**
 * Upcoming, undecided matches for whoever holds this Discord identity.
 *
 * Both the id AND the username are sent, because MSP stores two different
 * things: a team's captain is recorded by snowflake, but the roster entries
 * hold whatever the captain typed into the "Discord Username" field. Sending
 * only the id would answer correctly for captains and tell every other
 * player on the roster they had no matches.
 */
function getMatchesForDiscordUser(discordId, username = null, limit = 5) {
    return callRpc('get_matches_for_discord_user', {
        p_discord_id: discordId,
        p_discord_username: username,
        p_limit: limit
    });
}

/** Tournaments currently accepting registrations. */
function getOpenTournaments(limit = 8) {
    return callRpc('get_open_tournaments_for_bot', { p_limit: limit });
}

/** Active partnered creators, in the site's own display order. */
function getPartners(limit = 25) {
    return callRpc('get_partners_for_bot', { p_limit: limit });
}

/** Open scrims, optionally narrowed to one game. */
function getOpenScrims(game = null, limit = 8) {
    return callRpc('get_open_scrims_for_bot', { p_game: game, p_limit: limit });
}

/**
 * Formats MSP's schedule value for Discord.
 *
 * Returns a Discord timestamp (<t:unix:F>) when the value parses, which
 * renders in each viewer's OWN timezone -- the right answer for a roster
 * spread across regions, and something a pre-formatted IST string can
 * never do. Falls back to the raw text if it will not parse, and to a
 * clear "not scheduled yet" when there is nothing at all.
 */
function discordTime(value) {
    if (!value) return null;
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) return String(value);
    const unix = Math.floor(ms / 1000);
    return `<t:${unix}:F> (<t:${unix}:R>)`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Formats a plain CALENDAR DATE (tournaments."startDate" is a `date`
 * column, with no time in it).
 *
 * Deliberately NOT a Discord timestamp. A date is not an instant, and
 * pushing one through a timezone conversion goes wrong three ways:
 *
 *   1. It invents a clock time. "2026-08-19" became midnight UTC, which
 *      rendered as "19 August 2026 05:30" for a reader in IST -- a start
 *      time the organizer never set and cannot change.
 *   2. The relative half reads as nonsense. A tournament starting today
 *      showed "(7 hours ago)".
 *   3. Worst of all, it can show the WRONG DAY. Midnight UTC is still the
 *      18th for every reader in the Americas.
 *
 * So this returns static text -- the same date every reader sees, which is
 * what a calendar date means. discordTime() stays the right tool for real
 * timestamps (match kickoff, scrim slots), where per-viewer local time is
 * genuinely the useful thing.
 */
function discordDate(value) {
    if (!value) return null;
    const s = String(value);
    // Parsed by hand rather than via Date, so no timezone is ever applied.
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (!m) return s;
    const month = MONTHS[Number(m[2]) - 1];
    if (!month) return s;
    return `${Number(m[3])} ${month} ${m[1]}`;
}

/**
 * The tournament's format, as a label.
 *
 * tournaments."teamSize" is a text column holding a COMPLETE label -- the
 * create form stores the literal string '1v1', or leaves it blank for a
 * standard team roster. It is not a number. Composing `${n}v${n}` from it
 * shipped "1v1v1v1" to Discord.
 *
 * Blank returns '' rather than assuming '5v5': the column is free text and
 * inventing a value for it would be a guess of the same kind.
 */
function teamFormatLabel(teamSize) {
    const s = (teamSize == null ? '' : String(teamSize)).trim();
    return s;
}

/**
 * 'players' for a solo event, 'teams' otherwise.
 *
 * A 1v1 tournament has no teams in it, and "0/64 teams" reads as a bug to
 * someone signing up alone. Mirrors participantNoun() in the website's
 * js/views-core.js -- the two must agree, since a player sees both.
 */
function participantNoun(teamSize, plural) {
    const solo = String(teamSize == null ? '' : teamSize).trim() === '1v1';
    if (plural) return solo ? 'players' : 'teams';
    return solo ? 'player' : 'team';
}

module.exports = {
    callRpc, getMatchesForDiscordUser, getOpenTournaments, getOpenScrims, getPartners,
    discordTime, discordDate, teamFormatLabel, participantNoun, SITE_URL
};
