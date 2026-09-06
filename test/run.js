/**
 * Discord bot tests. No dependencies beyond what the bot already installs.
 *
 *   node test/run.js       (from discord-bot/)
 *
 * Everything here runs offline. Nothing contacts Discord or Supabase: the
 * network calls are exercised against a local throwaway server, which is the
 * only honest way to check that a failing lookup returns null rather than
 * throwing -- the property all three slash commands depend on.
 */
const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

let passed = 0, failed = 0;
function describe(name, fn) { console.log('\n' + name); return fn(); }
async function it(name, fn) {
    try { await fn(); passed++; console.log('  \u2713 ' + name); }
    catch (e) { failed++; console.log('  \u2717 ' + name + '\n      ' + e.message); }
}

(async function main() {

// ---------------------------------------------------------------
// Command modules -- what index.js will actually try to register.
// ---------------------------------------------------------------
await describe('commands -- every file is registerable', async () => {
    const dir = path.join(__dirname, '..', 'src', 'commands');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
    const loaded = files.map(f => ({ file: f, mod: require(path.join(dir, f)) }));

    await it('the three new read commands exist', () => {
        for (const want of ['mymatch.js', 'tournaments.js', 'scrims.js']) {
            assert.ok(files.includes(want), 'missing ' + want);
        }
    });

    await it('each exports both data and execute', () => {
        for (const entry of loaded) {
            assert.ok(entry.mod.data, entry.file + ' has no .data');
            assert.strictEqual(typeof entry.mod.execute, 'function', entry.file + ' has no .execute');
        }
    });

    await it('each name is lowercase and <= 32 chars (Discord rejects otherwise)', () => {
        for (const entry of loaded) {
            const n = entry.mod.data.name;
            assert.strictEqual(n, n.toLowerCase(), entry.file + ': name not lowercase');
            assert.ok(n.length > 0 && n.length <= 32, entry.file + ': bad name length');
        }
    });

    await it('no two commands claim the same name', () => {
        const names = loaded.map(x => x.mod.data.name);
        assert.strictEqual(new Set(names).size, names.length, 'duplicate in: ' + names.join(','));
    });

    await it('toJSON() succeeds -- the step deploy-commands actually performs', () => {
        for (const entry of loaded) {
            const json = entry.mod.data.toJSON();
            assert.ok(json.name && json.description, entry.file + ': incomplete payload');
        }
    });
});

// ---------------------------------------------------------------
// discordTime -- renders in each viewer's own timezone, or degrades.
// ---------------------------------------------------------------
await describe('discordTime -- schedule formatting', async () => {
    const discordTime = require('../src/lib/mspApi').discordTime;

    await it('null when there is nothing to show', () => {
        assert.strictEqual(discordTime(null), null);
        assert.strictEqual(discordTime(''), null);
        assert.strictEqual(discordTime(undefined), null);
    });

    await it('an ISO timestamp becomes a Discord timestamp', () => {
        const out = discordTime('2026-09-01T14:30:00Z');
        assert.ok(/^<t:\d+:F> \(<t:\d+:R>\)$/.test(out), 'got: ' + out);
    });

    await it('the unix value is correct, not merely well-formed', () => {
        const out = discordTime('2026-09-01T14:30:00Z');
        const unix = Number(out.match(/^<t:(\d+):F>/)[1]);
        assert.strictEqual(unix, Math.floor(Date.parse('2026-09-01T14:30:00Z') / 1000));
    });

    await it('both forms carry the same instant', () => {
        const out = discordTime('2026-09-01T14:30:00Z');
        const stamps = out.match(/<t:(\d+):[FR]>/g).map(s => s.match(/\d+/)[0]);
        assert.strictEqual(stamps[0], stamps[1]);
    });

    await it('a plain date still parses, for callers that want an instant', () => {
        assert.ok(String(discordTime('2026-09-01')).startsWith('<t:'));
    });

    await it('unparseable text falls through unchanged rather than vanishing', () => {
        assert.strictEqual(discordTime('sometime next week'), 'sometime next week');
    });

    await it('never throws on a non-string', () => {
        assert.doesNotThrow(function () { discordTime(12345); });
        assert.doesNotThrow(function () { discordTime({}); });
    });
});

// ---------------------------------------------------------------
// discordDate -- a calendar date is not an instant.
//
// tournaments."startDate" is a `date` column. Rendering it as a Discord
// timestamp showed "19 August 2026 05:30 (7 hours ago)" -- a clock time
// nobody set, a nonsense relative offset, and, for readers west of UTC,
// the wrong day entirely.
// ---------------------------------------------------------------
await describe('discordDate -- plain calendar dates', async () => {
    const discordDate = require('../src/lib/mspApi').discordDate;

    await it('renders a date as static text', () => {
        assert.strictEqual(discordDate('2026-08-19'), '19 Aug 2026');
    });

    await it('emits NO Discord timestamp markup -- that is the whole point', () => {
        assert.ok(discordDate('2026-08-19').indexOf('<t:') === -1);
    });

    await it('no invented clock time', () => {
        assert.ok(!/\d{1,2}:\d{2}/.test(discordDate('2026-08-19')));
    });

    // The regression that made this more than cosmetic: midnight UTC on the
    // 19th is still the 18th in the Americas, so the old code showed half
    // the world the wrong start day.
    await it('the day never shifts, whatever the reader timezone', () => {
        const saved = process.env.TZ;
        const seen = new Set();
        for (const tz of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
            process.env.TZ = tz;
            seen.add(discordDate('2026-08-19'));
        }
        if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
        assert.strictEqual(seen.size, 1, 'date drifted across timezones: ' + [...seen].join(' | '));
        assert.strictEqual([...seen][0], '19 Aug 2026');
    });

    await it('single-digit days are not zero-padded', () => {
        assert.strictEqual(discordDate('2026-09-01'), '1 Sep 2026');
    });

    await it('every month maps to the right name', () => {
        assert.strictEqual(discordDate('2026-01-15'), '15 Jan 2026');
        assert.strictEqual(discordDate('2026-12-31'), '31 Dec 2026');
    });

    await it('a full timestamp is accepted, date part only', () => {
        assert.strictEqual(discordDate('2026-08-19T18:30:00Z'), '19 Aug 2026');
    });

    await it('nothing in, null out', () => {
        assert.strictEqual(discordDate(null), null);
        assert.strictEqual(discordDate(''), null);
    });

    await it('unrecognised input falls through rather than vanishing', () => {
        assert.strictEqual(discordDate('next Tuesday'), 'next Tuesday');
    });

    await it('an impossible month falls through instead of printing undefined', () => {
        assert.strictEqual(discordDate('2026-13-01'), '2026-13-01');
    });

    await it('never throws on a non-string', () => {
        assert.doesNotThrow(function () { discordDate(12345); });
        assert.doesNotThrow(function () { discordDate({}); });
    });
});

// ---------------------------------------------------------------
// callRpc -- must resolve null on every failure, never reject.
//
// A rejected promise inside an interaction handler leaves the user staring
// at "The application did not respond", and an unhandled rejection can take
// the gateway connection down with it.
// ---------------------------------------------------------------
await describe('callRpc -- failure is always null, never a throw', async () => {
    const modPath = require.resolve('../src/lib/mspApi');

    function freshApi(env) {
        delete require.cache[modPath];
        const before = {};
        for (const k of Object.keys(env)) { before[k] = process.env[k]; process.env[k] = env[k]; }
        const api = require(modPath);
        return {
            api: api,
            restore: function () {
                for (const k of Object.keys(before)) {
                    if (before[k] === undefined) delete process.env[k];
                    else process.env[k] = before[k];
                }
                delete require.cache[modPath];
            }
        };
    }

    const realErr = console.error;
    console.error = function () {};

    try {
        await it('missing credentials -> null, no network attempt', async () => {
            const h = freshApi({ SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' });
            try { assert.strictEqual(await h.api.callRpc('anything', {}), null); }
            finally { h.restore(); }
        });

        // One local server, several behaviours, so the HTTP paths are
        // exercised for real rather than mocked into agreeing with me.
        // It also records what was sent, so the wrapper tests can assert on
        // the actual request body rather than trusting the argument list.
        const seen = [];
        const server = http.createServer(function (req, res) {
            let body = '';
            req.on('data', function (c) { body += c; });
            req.on('end', function () {
                seen.push({ url: req.url, body: body });
                if (req.url.indexOf('notfound') !== -1) { res.writeHead(404); res.end('{"message":"no function"}'); return; }
                if (req.url.indexOf('boom') !== -1)     { res.writeHead(500); res.end('kaboom'); return; }
                if (req.url.indexOf('garbage') !== -1)  { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('not json'); return; }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('[{"ok":true}]');
            });
        });
        await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
        const base = 'http://127.0.0.1:' + server.address().port;
        const live = freshApi({ SUPABASE_URL: base, SUPABASE_SERVICE_ROLE_KEY: 'test-key' });

        try {
            await it('a 404 (function does not exist) -> null', async () => {
                assert.strictEqual(await live.api.callRpc('notfound', {}), null);
            });
            await it('a 500 -> null', async () => {
                assert.strictEqual(await live.api.callRpc('boom', {}), null);
            });
            await it('a 200 with unparseable body -> null, not a throw', async () => {
                assert.strictEqual(await live.api.callRpc('garbage', {}), null);
            });
            await it('success returns the parsed rows', async () => {
                assert.deepStrictEqual(await live.api.callRpc('fine', {}), [{ ok: true }]);
            });

            // MSP stores a captain by snowflake and roster members by the
            // username typed at registration. Sending only the id answers
            // correctly for captains and tells everyone else they have no
            // matches -- a failure with no error attached to it. These
            // assert on the wire, not on the call signature.
            await it('/mymatch sends BOTH the id and the username', async () => {
                seen.length = 0;
                await live.api.getMatchesForDiscordUser('99988877', 'tankytank', 5);
                const sent = JSON.parse(seen[seen.length - 1].body);
                assert.strictEqual(sent.p_discord_id, '99988877');
                assert.strictEqual(sent.p_discord_username, 'tankytank');
                assert.strictEqual(sent.p_limit, 5);
            });

            await it('it hits the right function name', async () => {
                seen.length = 0;
                await live.api.getMatchesForDiscordUser('1', 'x');
                assert.ok(seen[seen.length - 1].url.endsWith('/rpc/get_matches_for_discord_user'),
                    'got: ' + seen[seen.length - 1].url);
            });

            await it('a missing username is sent as null, not undefined', async () => {
                // JSON.stringify drops undefined keys entirely, which makes
                // PostgREST fall back to the default -- fine here, but only
                // by accident. null is what the function signature expects.
                seen.length = 0;
                await live.api.getMatchesForDiscordUser('123');
                const sent = JSON.parse(seen[seen.length - 1].body);
                assert.ok('p_discord_username' in sent, 'key was dropped from the payload');
                assert.strictEqual(sent.p_discord_username, null);
            });

            await it('/scrims sends null for "any game", not undefined', async () => {
                seen.length = 0;
                await live.api.getOpenScrims();
                const sent = JSON.parse(seen[seen.length - 1].body);
                assert.ok('p_game' in sent, 'key was dropped from the payload');
                assert.strictEqual(sent.p_game, null);
            });
        } finally {
            live.restore();
            // Await the close callback rather than firing and forgetting.
            // Exiting with the listen handle still tearing down trips a
            // libuv assertion on Windows and reports failure on a green run.
            await new Promise(function (r) { server.close(r); });
        }

        await it('an unreachable host -> null, not a throw', async () => {
            const dead = freshApi({ SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'k' });
            try { assert.strictEqual(await dead.api.callRpc('x', {}), null); }
            finally { dead.restore(); }
        });

        await it('all three wrappers reach callRpc and survive a bad host', async () => {
            const dead = freshApi({ SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'k' });
            try {
                assert.strictEqual(await dead.api.getMatchesForDiscordUser('123'), null);
                assert.strictEqual(await dead.api.getOpenTournaments(), null);
                assert.strictEqual(await dead.api.getOpenScrims(), null);
            } finally { dead.restore(); }
        });
    } finally {
        console.error = realErr;
    }
});

// ---------------------------------------------------------------
// Tournament labelling. Both of these shipped wrong once, and neither
// throws -- they just render nonsense, so only a test catches them.
// ---------------------------------------------------------------
await describe('teamFormatLabel / participantNoun', async () => {
    const { teamFormatLabel, participantNoun } = require('../src/lib/mspApi');

    // The bug: teamSize holds the finished label '1v1', not a number, so
    // building `${n}v${n}` from it rendered "1v1v1v1" in the embed.
    await it("'1v1' is passed through, NOT doubled into 1v1v1v1", () => {
        assert.strictEqual(teamFormatLabel('1v1'), '1v1');
    });

    await it('blank means "not stated" -- no invented 5v5', () => {
        assert.strictEqual(teamFormatLabel(''), '');
        assert.strictEqual(teamFormatLabel(null), '');
        assert.strictEqual(teamFormatLabel(undefined), '');
    });

    await it('any other stored label survives intact', () => {
        assert.strictEqual(teamFormatLabel('5v5'), '5v5');
        assert.strictEqual(teamFormatLabel(' 3v3 '), '3v3');
    });

    await it('a 1v1 event counts players, not teams', () => {
        assert.strictEqual(participantNoun('1v1', true), 'players');
        assert.strictEqual(participantNoun('1v1', false), 'player');
    });

    await it('everything else counts teams', () => {
        assert.strictEqual(participantNoun('5v5', true), 'teams');
        assert.strictEqual(participantNoun('', true), 'teams');
        assert.strictEqual(participantNoun(null, true), 'teams');
    });

    await it('the assembled line reads correctly for a solo event', () => {
        const t = { game: 'Mobile Legends', teamSize: '1v1', registered: 0, participants: 64 };
        const fmt = teamFormatLabel(t.teamSize);
        const line = `${t.game}${fmt ? ' · ' + fmt : ''} · ${t.registered}/${t.participants} ${participantNoun(t.teamSize, true)}`;
        assert.strictEqual(line, 'Mobile Legends · 1v1 · 0/64 players');
    });

    await it('and for a standard team event with no size stored', () => {
        const t = { game: 'Honor of Kings', teamSize: '', registered: 4, participants: 16 };
        const fmt = teamFormatLabel(t.teamSize);
        const line = `${t.game}${fmt ? ' · ' + fmt : ''} · ${t.registered}/${t.participants} ${participantNoun(t.teamSize, true)}`;
        assert.strictEqual(line, 'Honor of Kings · 4/16 teams');
    });
});

// ---------------------------------------------------------------
// SITE_URL -- the links are the fallback when an RPC is unreachable, so a
// malformed one breaks precisely the path that runs when things go wrong.
// ---------------------------------------------------------------
await describe('SITE_URL', async () => {
    const modPath = require.resolve('../src/lib/mspApi');
    const saved = process.env.SITE_URL;

    await it('a trailing slash is stripped so links never double up', () => {
        delete require.cache[modPath];
        process.env.SITE_URL = 'https://example.test/';
        assert.strictEqual(require(modPath).SITE_URL, 'https://example.test');
    });

    // Pinned to the exact host, not just "looks like a URL". The default
    // was mobaesports.netlify.app for one deploy -- a well-formed URL to a
    // site that is not this one, so every fallback link 404'd.
    await it('defaults to the real production host when unset', () => {
        delete require.cache[modPath];
        delete process.env.SITE_URL;
        const url = require(modPath).SITE_URL;
        assert.strictEqual(url, 'https://mobaesportsplatform.netlify.app');
    });

    if (saved === undefined) delete process.env.SITE_URL; else process.env.SITE_URL = saved;
    delete require.cache[modPath];
});

// ---------------------------------------------------------------
// The scheduler. Every test drives runDue() directly with an injected
// clock -- no real timers, so the suite stays instant and deterministic.
// ---------------------------------------------------------------
await describe('scheduler -- runs work on time without stacking or dying', async () => {
    const { createScheduler } = require(path.join(__dirname, '..', 'src', 'lib', 'scheduler'));
    const quiet = () => {};
    const clock = (start) => { let t = start; return { now: () => t, advance: (ms) => { t += ms; } }; };

    await it('does not run a job before it is due', async () => {
        const c = clock(0);
        let runs = 0;
        const s = createScheduler({ now: c.now, log: quiet });
        s.register({ name: 'a', everyMs: 1000, run: async () => { runs++; } });
        await s.runDue();
        assert.strictEqual(runs, 0, 'ran early');
        c.advance(999);
        await s.runDue();
        assert.strictEqual(runs, 0, 'ran one tick early');
        c.advance(1);
        await s.runDue();
        assert.strictEqual(runs, 1);
    });

    await it('the first run waits a full interval rather than firing at boot', async () => {
        const c = clock(0);
        let runs = 0;
        const s = createScheduler({ now: c.now, log: quiet });
        s.register({ name: 'a', everyMs: 5000, run: async () => { runs++; } });
        await s.runDue();
        // Startup is this process's least stable moment -- gateway
        // handshake, command registration -- and a sweep fired into it has
        // the worst chance of succeeding.
        assert.strictEqual(runs, 0);
    });

    await it('one job throwing does not stop the others', async () => {
        const c = clock(0);
        let good = 0;
        const s = createScheduler({ now: c.now, log: quiet });
        s.register({ name: 'bad', everyMs: 1000, run: async () => { throw new Error('boom'); } });
        s.register({ name: 'good', everyMs: 1000, run: async () => { good++; } });
        c.advance(1000);
        await s.runDue();
        assert.strictEqual(good, 1, 'the healthy job was skipped because a sibling threw');
        const st = s.status();
        assert.strictEqual(st.jobs[0].failures, 1);
        assert.strictEqual(st.jobs[0].lastError, 'boom');
        assert.strictEqual(st.jobs[1].failures, 0);
    });

    await it('a throwing job never rejects out of runDue', async () => {
        // An unhandled rejection here would take the whole bot down --
        // Discord connection included -- which has happened to this
        // process before via a different route.
        const c = clock(0);
        const s = createScheduler({ now: c.now, log: quiet });
        s.register({ name: 'bad', everyMs: 1000, run: async () => { throw new Error('boom'); } });
        c.advance(1000);
        await s.runDue();
    });

    await it('does not stack a job that is still running', async () => {
        const c = clock(0);
        let started = 0, release;
        const s = createScheduler({ now: c.now, log: quiet });
        s.register({
            name: 'slow', everyMs: 1000,
            run: () => { started++; return new Promise(r => { release = r; }); }
        });
        c.advance(1000);
        const first = s.runDue();
        c.advance(1000);
        // Raced against a timeout on purpose. Without the overlap guard
        // this second pass starts the job again and awaits a promise
        // nothing will ever resolve -- which would hang the whole suite
        // instead of failing this one test, and take every check after it
        // down with it.
        const settled = await Promise.race([
            s.runDue().then(() => 'done'),
            new Promise(r => setTimeout(() => r('hung'), 200))
        ]);
        assert.strictEqual(settled, 'done', 'runDue never returned -- the overlap guard is gone');
        assert.strictEqual(started, 1, 'a second copy started while the first was in flight');
        assert.strictEqual(s.status().jobs[0].skips, 1, 'the skip was not recorded');
        release();
        await first;
    });

    await it('an enabled() gate skips without counting as a failure', async () => {
        const c = clock(0);
        let runs = 0, up = false;
        const s = createScheduler({ now: c.now, log: quiet });
        s.register({ name: 'gated', everyMs: 1000, enabled: () => up, run: async () => { runs++; } });
        c.advance(1000);
        await s.runDue();
        assert.strictEqual(runs, 0);
        assert.strictEqual(s.status().jobs[0].failures, 0, 'a skip was recorded as a failure');
        assert.strictEqual(s.status().jobs[0].skips, 1);
        up = true;
        c.advance(1000);
        await s.runDue();
        assert.strictEqual(runs, 1);
    });

    await it('reschedules from the END of a run, so a slow job cannot be permanently due', async () => {
        const c = clock(0);
        let runs = 0;
        const s = createScheduler({ now: c.now, log: quiet });
        s.register({ name: 'slow', everyMs: 1000, run: async () => { runs++; c.advance(5000); } });
        c.advance(1000);
        await s.runDue();
        assert.strictEqual(runs, 1);
        await s.runDue();
        assert.strictEqual(runs, 1, 'a slow job re-fired immediately instead of waiting its interval');
    });

    await it('refuses two jobs with the same name', async () => {
        const s = createScheduler({ now: () => 0, log: quiet });
        s.register({ name: 'a', everyMs: 1000, run: async () => {} });
        assert.throws(() => s.register({ name: 'a', everyMs: 1000, run: async () => {} }), /duplicate/);
    });

    await it('rejects a malformed job rather than registering something that cannot run', async () => {
        const s = createScheduler({ now: () => 0, log: quiet });
        assert.throws(() => s.register({ name: 'x' }), /needs/);
        assert.throws(() => s.register(null), /needs/);
    });

    await it('reports a stalled job -- the failure mode nobody noticed last time', async () => {
        const c = clock(0);
        const s = createScheduler({ now: c.now, log: quiet });
        s.register({ name: 'a', everyMs: 1000, run: async () => {} });
        s.start(100000);
        c.advance(1000);
        await s.runDue();
        assert.strictEqual(s.status().jobs[0].stalled, false);
        c.advance(3001);
        assert.strictEqual(s.status().jobs[0].stalled, true,
            'a timer that stopped firing must be visible from /health');
        s.stop();
    });

    await it('keeps only small scalar values in the status payload', async () => {
        // /health is read by an uptime monitor, not a debugger -- a job's
        // return value must not become a data leak.
        const c = clock(0);
        const s = createScheduler({ now: c.now, log: quiet });
        s.register({
            name: 'a', everyMs: 1000,
            run: async () => ({ scrims: 2, secret: { token: 'abc' }, note: 'x'.repeat(500) })
        });
        c.advance(1000);
        await s.runDue();
        const r = s.status().jobs[0].lastResult;
        assert.strictEqual(r.scrims, 2);
        assert.strictEqual(r.secret, undefined, 'a nested object reached the health payload');
        assert.ok(r.note.length <= 80, 'a long string was not truncated');
    });

    await it('truncates an error message and never exposes a stack', async () => {
        const c = clock(0);
        const s = createScheduler({ now: c.now, log: quiet });
        s.register({ name: 'a', everyMs: 1000, run: async () => { throw new Error('y'.repeat(500)); } });
        c.advance(1000);
        await s.runDue();
        const err = s.status().jobs[0].lastError;
        assert.ok(err.length <= 200);
        assert.ok(err.indexOf('at ') === -1, 'a stack frame leaked into the status payload');
    });
});

// ---------------------------------------------------------------
// The scrim reminder sweep itself -- fully injected, so none of this
// touches Discord or Supabase.
// ---------------------------------------------------------------
await describe('scrim reminders -- the sweep that had nowhere to run', async () => {
    const { createScrimReminderJob, formatWhen } =
        require(path.join(__dirname, '..', 'src', 'jobs', 'scrimReminders'));
    const quiet = () => {};

    const scrim = (id) => ({
        id: id, creatorOwnerId: 'u1', opponentOwnerId: 'u2',
        scheduledAt: '2026-09-04T14:30:00Z'
    });

    function harness(overrides) {
        const o = overrides || {};
        const calls = [];
        const dms = [];
        // One interleaved log across both dependencies. Two separate
        // arrays cannot answer "did the DM happen before the mark?", which
        // is the ordering the whole retry story depends on.
        const events = [];
        const job = createScrimReminderJob({
            log: quiet,
            gatewayUp: o.gatewayUp !== undefined ? o.gatewayUp : (() => true),
            callRpc: async (name, args) => {
                calls.push({ name: name, args: args });
                events.push(name === 'mark_scrim_reminder_sent' ? 'mark:' + args.p_scrim_id : 'rpc:' + name);
                if (name === 'get_scrims_needing_reminder') {
                    return o.scrims === undefined ? [] : o.scrims;
                }
                return o.markFails ? null : {};
            },
            dmUser: async (id, text) => {
                dms.push({ id: id, text: text });
                events.push('dm:' + id);
                return { ok: !o.dmFails };
            }
        });
        return { job: job, calls: calls, dms: dms, events: events };
    }

    await it('does nothing at all while Discord is disconnected', async () => {
        // THE bug this guard exists for: the original endpoint marked
        // every scrim as reminded even when every DM had failed, turning
        // a temporary outage into permanently missed reminders.
        const h = harness({ gatewayUp: () => false, scrims: [scrim('S-1')] });
        const r = await h.job.run();
        assert.strictEqual(r.skipped, 'discord-disconnected');
        assert.strictEqual(h.calls.length, 0, 'it queried Supabase with no way to deliver');
        assert.strictEqual(h.dms.length, 0);
    });

    await it('reports an unreachable Supabase without throwing', async () => {
        const h = harness({ scrims: null });
        const r = await h.job.run();
        assert.strictEqual(r.error, 'supabase-unreachable');
        assert.strictEqual(h.dms.length, 0);
    });

    await it('is a quiet no-op when nothing is due', async () => {
        const h = harness({ scrims: [] });
        const r = await h.job.run();
        assert.deepStrictEqual(r, { scrims: 0, dms: 0 });
        assert.strictEqual(h.calls.length, 1, 'it did more than the one query');
    });

    await it('DMs both squad owners and then marks the scrim', async () => {
        const h = harness({ scrims: [scrim('S-1')] });
        const r = await h.job.run();
        assert.strictEqual(r.dms, 2);
        assert.deepStrictEqual(h.dms.map(d => d.id), ['u1', 'u2']);
        const marks = h.calls.filter(c => c.name === 'mark_scrim_reminder_sent');
        assert.strictEqual(marks.length, 1);
        assert.strictEqual(marks[0].args.p_scrim_id, 'S-1');
    });

    await it('marks AFTER sending, never before', async () => {
        // Marking first turns a failed send into a silent permanent miss.
        // This order turns it into a duplicate at worst.
        const h = harness({ scrims: [scrim('S-1')] });
        await h.job.run();
        assert.deepStrictEqual(h.events,
            ['rpc:get_scrims_needing_reminder', 'dm:u1', 'dm:u2', 'mark:S-1'],
            'the sweep did not query, then send, then mark -- in that order');
    });

    await it('still marks when a DM bounces, since that is a permanent condition', async () => {
        // The gateway is up, so a failure here means DMs are closed or the
        // player left -- retrying every five minutes helps nobody.
        const h = harness({ scrims: [scrim('S-1')], dmFails: true });
        const r = await h.job.run();
        assert.strictEqual(r.dms, 0);
        assert.strictEqual(r.failed, 2);
        assert.strictEqual(r.marked, 1);
    });

    await it('leaves the scrim unmarked when the mark itself fails, so the next tick retries', async () => {
        const h = harness({ scrims: [scrim('S-1')], markFails: true });
        const r = await h.job.run();
        assert.strictEqual(r.marked, 0);
    });

    await it('skips a missing owner id instead of DMing undefined', async () => {
        const h = harness({ scrims: [{ id: 'S-1', creatorOwnerId: 'u1', opponentOwnerId: null,
                                       scheduledAt: '2026-09-04T14:30:00Z' }] });
        const r = await h.job.run();
        assert.strictEqual(r.dms, 1);
        assert.deepStrictEqual(h.dms.map(d => d.id), ['u1']);
    });

    await it('handles several scrims in one sweep', async () => {
        const h = harness({ scrims: [scrim('S-1'), scrim('S-2')] });
        const r = await h.job.run();
        assert.strictEqual(r.scrims, 2);
        assert.strictEqual(r.dms, 4);
        assert.strictEqual(h.calls.filter(c => c.name === 'mark_scrim_reminder_sent').length, 2);
    });

    await it('puts a readable IST time in the message, not a raw UTC stamp', async () => {
        const h = harness({ scrims: [scrim('S-1')] });
        await h.job.run();
        const text = h.dms[0].text;
        assert.ok(text.indexOf('IST') !== -1, 'no timezone the reader can act on: ' + text);
        assert.ok(text.indexOf('2026-09-04T14:30:00Z') === -1, 'the raw stamp leaked into the DM');
    });

    await it('never throws on a missing or malformed time', async () => {
        assert.strictEqual(formatWhen(null), 'soon');
        assert.strictEqual(formatWhen(''), 'soon');
        assert.strictEqual(formatWhen('not a date'), 'soon');
    });
});

// ---------------------------------------------------------------
// Wiring. The point of this feature is that something actually calls
// the sweep -- the SQL, the endpoint and the idempotency all existed
// already and sat dead for want of a caller.
// ---------------------------------------------------------------
await describe('scheduler wiring -- the sweep has a caller', async () => {
    const root = path.join(__dirname, '..');
    const index = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
    const router = fs.readFileSync(path.join(root, 'src', 'api', 'apiRouter.js'), 'utf8');

    await it('the bot registers the scrim sweep on its own timer', async () => {
        assert.ok(/createScheduler\(\)/.test(index), 'no scheduler is built');
        assert.ok(/name: 'scrim-reminders'/.test(index), 'the sweep is not registered');
    });

    await it('and starts it only once Discord is connected', async () => {
        assert.ok(/client\.once\('ready'[\s\S]{0,700}scheduler\.start/.test(index),
            'the timer starts before the gateway is up');
    });

    await it('a stalled timer is visible on /health', async () => {
        assert.ok(/scheduler: \(\(\) => \{ try \{ return scheduler\.status\(\)/.test(index),
            'nothing reports the scheduler state -- the exact gap that hid the last failure');
    });

    await it('the endpoint and the timer share one implementation', async () => {
        assert.ok(/createScrimReminderJob/.test(router), 'the route does not use the shared job');
        assert.ok(/scrimReminderJob\.run\(\)/.test(router), 'the route still has its own copy of the loop');
        assert.ok(!/get_scrims_needing_reminder', \{\}\);[\s\S]{0,40}if \(!scrims\)/.test(router),
            'the original inline sweep is still in the route');
    });

    await it('the bot does not HTTP-call itself to reach its own function', async () => {
        assert.ok(!/fetch\([^)]*scrim-reminders-tick/.test(index),
            'the scheduler goes back out over the network to reach code in this process');
    });
});

// ---------------------------------------------------------------
// YouTube subscriber badge.
// ---------------------------------------------------------------
await describe('youtube -- channel URLs', async () => {
    const { parseYouTubeChannel } = require('../src/lib/youtube');

    await it('resolves the two forms the API can answer in one call', () => {
        assert.deepStrictEqual(parseYouTubeChannel('https://www.youtube.com/@MSPesports'),
            { type: 'handle', value: 'MSPesports' });
        assert.deepStrictEqual(parseYouTubeChannel('https://youtube.com/channel/UCabcdefghijklmnopqrstuv'),
            { type: 'id', value: 'UCabcdefghijklmnopqrstuv' });
        assert.deepStrictEqual(parseYouTubeChannel('https://m.youtube.com/@a_b.c-d'),
            { type: 'handle', value: 'a_b.c-d' });
    });

    await it('refuses the legacy forms rather than guessing a channel', () => {
        // /c/ and /user/ need a search call: 100 quota units for a result
        // that can be the wrong channel. No badge beats a wrong number.
        assert.strictEqual(parseYouTubeChannel('https://youtube.com/c/SomeName'), null);
        assert.strictEqual(parseYouTubeChannel('https://youtube.com/user/SomeName'), null);
    });

    await it('a video link is not a channel', () => {
        assert.strictEqual(parseYouTubeChannel('https://youtube.com/watch?v=dQw4w9WgXcQ'), null);
    });

    await it('rejects other hosts, other protocols and malformed ids', () => {
        assert.strictEqual(parseYouTubeChannel('https://youtube.com.evil.tld/@x'), null);
        assert.strictEqual(parseYouTubeChannel('javascript:alert(1)'), null);
        assert.strictEqual(parseYouTubeChannel('https://vimeo.com/@x'), null);
        assert.strictEqual(parseYouTubeChannel('https://youtube.com/channel/NOTUC'), null);
        assert.strictEqual(parseYouTubeChannel('https://youtube.com/@ab'), null);
        assert.strictEqual(parseYouTubeChannel(''), null);
        assert.strictEqual(parseYouTubeChannel(null), null);
    });
});

await describe('youtube -- how the number reads', async () => {
    const { formatSubscribers } = require('../src/lib/youtube');

    await it('matches the shape YouTube itself prints', () => {
        assert.strictEqual(formatSubscribers(999), '999');
        assert.strictEqual(formatSubscribers(1234), '1.23K');
        assert.strictEqual(formatSubscribers(45678), '45.7K');
        assert.strictEqual(formatSubscribers(1234567), '1.23M');
    });

    await it('promotes the unit when rounding rolls over', () => {
        // The first version answered "1000K" here: it picked the unit from
        // the raw value, then rounded 999.999 up to 1000 inside it.
        assert.strictEqual(formatSubscribers(999999), '1M');
        assert.strictEqual(formatSubscribers(999999999), '1B');
    });

    await it('returns null for anything that is not a count', () => {
        assert.strictEqual(formatSubscribers(-1), null);
        assert.strictEqual(formatSubscribers('abc'), null);
        assert.strictEqual(formatSubscribers(Infinity), null);
        assert.strictEqual(formatSubscribers(undefined), null);
    });
});

await describe('youtube -- lookups', async () => {
    const { createYouTubeStats } = require('../src/lib/youtube');
    const CHANNEL = 'https://youtube.com/@someone';

    const build = (over) => {
        const calls = [];
        const stats = createYouTubeStats(Object.assign({
            apiKey: 'test-key',
            log: () => {},
            fetchJson: async (url) => {
                calls.push(url);
                return { items: [{ statistics: { subscriberCount: '12345' }, snippet: { title: 'Someone' } }] };
            }
        }, over || {}));
        return { stats, calls };
    };

    await it('returns the count, formatted, with the channel title', async () => {
        const { stats } = build();
        const r = await stats.subscribersFor(CHANNEL);
        assert.deepStrictEqual(r, { ok: true, subscribers: 12345, display: '12.3K', title: 'Someone' });
    });

    await it('asks by handle for @links and by id for /channel/ links', async () => {
        const { stats, calls } = build();
        await stats.subscribersFor(CHANNEL);
        await stats.subscribersFor('https://youtube.com/channel/UCabcdefghijklmnopqrstuv');
        assert.ok(calls[0].includes('forHandle=%40someone'), 'handle call: ' + calls[0]);
        assert.ok(calls[1].includes('id=UCabcdefghijklmnopqrstuv'), 'id call: ' + calls[1]);
    });

    await it('never contacts YouTube without a key', async () => {
        const { stats, calls } = build({ apiKey: '' });
        assert.deepStrictEqual(await stats.subscribersFor(CHANNEL), { ok: false, reason: 'not-configured' });
        assert.strictEqual(calls.length, 0);
    });

    await it('never contacts YouTube for a URL it cannot use', async () => {
        const { stats, calls } = build();
        assert.deepStrictEqual(await stats.subscribersFor('https://youtube.com/c/Legacy'),
            { ok: false, reason: 'unsupported-url' });
        assert.strictEqual(calls.length, 0);
    });

    await it('serves a repeat from cache instead of spending quota', async () => {
        const { stats, calls } = build();
        await stats.subscribersFor(CHANNEL);
        await stats.subscribersFor(CHANNEL);
        await stats.subscribersFor(CHANNEL);
        assert.strictEqual(calls.length, 1, 'called YouTube ' + calls.length + ' times for one channel');
    });

    await it('calls again once the cache has expired', async () => {
        let t = 1000;
        const { stats, calls } = build({ now: () => t });
        await stats.subscribersFor(CHANNEL);
        t += 6 * 60 * 60 * 1000 + 1;
        await stats.subscribersFor(CHANNEL);
        assert.strictEqual(calls.length, 2);
    });

    await it('collapses a burst for the same channel into one call', async () => {
        // The cache is written when a fetch RESOLVES. Without in-flight
        // dedupe, every visitor arriving before the first response landed
        // would spend a quota unit of their own.
        let release;
        const gate = new Promise(res => { release = res; });
        const calls = [];
        const stats = createYouTubeStats({
            apiKey: 'k', log: () => {},
            fetchJson: async (url) => {
                calls.push(url);
                await gate;
                return { items: [{ statistics: { subscriberCount: '500' } }] };
            }
        });
        const all = Promise.all([1, 2, 3, 4, 5].map(() => stats.subscribersFor(CHANNEL)));
        release();
        const results = await all;
        assert.strictEqual(calls.length, 1, 'made ' + calls.length + ' calls for one burst');
        results.forEach(r => assert.strictEqual(r.display, '500'));
    });

    await it('stops calling once the daily budget is spent', async () => {
        const calls = [];
        const stats = createYouTubeStats({
            apiKey: 'k', log: () => {}, maxPerDay: 2,
            fetchJson: async (url) => {
                calls.push(url);
                return { items: [{ statistics: { subscriberCount: '1' } }] };
            }
        });
        await stats.subscribersFor('https://youtube.com/@aaa');
        await stats.subscribersFor('https://youtube.com/@bbb');
        const third = await stats.subscribersFor('https://youtube.com/@ccc');
        assert.deepStrictEqual(third, { ok: false, reason: 'budget' });
        assert.strictEqual(calls.length, 2, 'spent ' + calls.length + ' units against a budget of 2');
    });

    await it('a spent budget still serves channels already cached', async () => {
        // Otherwise the first stranger to exhaust the budget takes the
        // badge off every real tournament on the platform.
        const stats = createYouTubeStats({
            apiKey: 'k', log: () => {}, maxPerDay: 1,
            fetchJson: async () => ({ items: [{ statistics: { subscriberCount: '900' } }] })
        });
        await stats.subscribersFor('https://youtube.com/@aaa');
        await stats.subscribersFor('https://youtube.com/@bbb');
        const again = await stats.subscribersFor('https://youtube.com/@aaa');
        assert.strictEqual(again.ok, true);
        assert.strictEqual(again.display, '900');
    });

    await it('the budget resets after a day', async () => {
        let t = 0;
        const calls = [];
        const stats = createYouTubeStats({
            apiKey: 'k', log: () => {}, maxPerDay: 1, now: () => t,
            fetchJson: async (u) => { calls.push(u); return { items: [{ statistics: { subscriberCount: '1' } }] }; }
        });
        await stats.subscribersFor('https://youtube.com/@aaa');
        assert.deepStrictEqual(await stats.subscribersFor('https://youtube.com/@bbb'), { ok: false, reason: 'budget' });
        t += 24 * 60 * 60 * 1000 + 1;
        const after = await stats.subscribersFor('https://youtube.com/@bbb');
        assert.strictEqual(after.ok, true);
        assert.strictEqual(calls.length, 2);
    });

    await it('reports hidden counts as hidden, not as zero', async () => {
        const { stats } = build({
            fetchJson: async () => ({ items: [{ statistics: { hiddenSubscriberCount: true } }] })
        });
        assert.deepStrictEqual(await stats.subscribersFor(CHANNEL), { ok: false, reason: 'hidden' });
    });

    await it('reports an absent count as hidden too', async () => {
        const { stats } = build({ fetchJson: async () => ({ items: [{ statistics: {} }] }) });
        assert.deepStrictEqual(await stats.subscribersFor(CHANNEL), { ok: false, reason: 'hidden' });
    });

    await it('reports an unknown channel as not-found', async () => {
        const { stats } = build({ fetchJson: async () => ({ items: [] }) });
        assert.deepStrictEqual(await stats.subscribersFor(CHANNEL), { ok: false, reason: 'not-found' });
    });

    await it('swallows a network failure instead of throwing at the page', async () => {
        const { stats } = build({ fetchJson: async () => { throw new Error('ECONNRESET'); } });
        assert.deepStrictEqual(await stats.subscribersFor(CHANNEL), { ok: false, reason: 'unreachable' });
    });

    await it('does not cache an outage -- the badge returns when YouTube does', async () => {
        let fail = true;
        const stats = createYouTubeStats({
            apiKey: 'k', log: () => {},
            fetchJson: async () => {
                if (fail) throw new Error('down');
                return { items: [{ statistics: { subscriberCount: '77' } }] };
            }
        });
        assert.strictEqual((await stats.subscribersFor(CHANNEL)).reason, 'unreachable');
        fail = false;
        assert.strictEqual((await stats.subscribersFor(CHANNEL)).display, '77');
    });

    await it('the API key never appears in anything it returns', async () => {
        const { stats } = build();
        const r = await stats.subscribersFor(CHANNEL);
        assert.ok(!JSON.stringify(r).includes('test-key'), 'the key leaked into the response body');
    });
});

await describe('youtube -- proving the channel is yours', async () => {
    const { createYouTubeStats } = require('../src/lib/youtube');
    const CHANNEL = 'https://youtube.com/@someone';
    const CODE = 'MSP-A7F3C9D2E1';

    // description and stats are what the fake API returns; calls records
    // the URLs, so "did it go to the network at all" is answerable.
    const build = (description, stats, over) => {
        const calls = [];
        const y = createYouTubeStats(Object.assign({
            apiKey: 'test-key',
            log: () => {},
            fetchJson: async (url) => {
                calls.push(url);
                return { items: [{ id: 'UCabc', snippet: { description, title: 'Someone' },
                                   statistics: stats || { subscriberCount: '12345' } }] };
            }
        }, over || {}));
        return { y, calls };
    };

    await it('says yes when the code is in the description', async () => {
        const { y } = build('We play games. ' + CODE + ' Subscribe!');
        const r = await y.verifyOwnership(CHANNEL, CODE);
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.channelId, 'UCabc');
        assert.strictEqual(r.subscribers, 12345);
        assert.strictEqual(r.display, '12.3K');
    });

    await it('says no when it is not, and still names the channel', async () => {
        const { y } = build('No code here.');
        const r = await y.verifyOwnership(CHANNEL, CODE);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'code-not-found');
        // The id is returned anyway: the caller can tell "wrong channel"
        // from "right channel, code missing" without a second lookup.
        assert.strictEqual(r.channelId, 'UCabc');
    });

    await it('matches case-insensitively -- people retype it by hand', async () => {
        const { y } = build('about us: msp-a7f3c9d2e1');
        assert.strictEqual((await y.verifyOwnership(CHANNEL, CODE)).ok, true);
    });

    await it('will not accept an empty code as a match', async () => {
        // Without this guard '' is a substring of every description in
        // existence, and every channel on YouTube verifies.
        const { y, calls } = build('anything at all');
        const r = await y.verifyOwnership(CHANNEL, '');
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'no-code');
        assert.strictEqual(calls.length, 0, 'it should not even ask YouTube');
    });

    await it('does not read the badge cache -- a description edited a minute ago must count', async () => {
        let description = 'nothing yet';
        const { y, calls } = build('placeholder', null, {
            fetchJson: async (url) => {
                calls.push(url);
                return { items: [{ id: 'UCabc', snippet: { description },
                                   statistics: { subscriberCount: '900' } }] };
            }
        });
        // Warm whatever cache exists, the way a page load would.
        await y.subscribersFor(CHANNEL);
        assert.strictEqual((await y.verifyOwnership(CHANNEL, CODE)).reason, 'code-not-found');

        description = 'now with ' + CODE;
        const r = await y.verifyOwnership(CHANNEL, CODE);
        assert.strictEqual(r.ok, true, 'a cached description would have failed this');
    });

    await it('does not poison the badge cache either', async () => {
        const { y } = build('has ' + CODE, { subscriberCount: '900' });
        await y.verifyOwnership(CHANNEL, CODE);
        const badge = await y.subscribersFor(CHANNEL);
        // If verifyOwnership had written its own shape into the cache,
        // the badge would come back with channelId/hiddenCount on it.
        assert.strictEqual(badge.ok, true);
        assert.strictEqual(badge.display, '900');
        assert.strictEqual(badge.channelId, undefined);
    });

    await it('reports a hidden subscriber count as null, not zero', async () => {
        const { y } = build('has ' + CODE, { hiddenSubscriberCount: true });
        const r = await y.verifyOwnership(CHANNEL, CODE);
        // Ownership IS proven -- the code is there. Only the number is
        // unavailable, and 0 would be a number we were never told.
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.subscribers, null);
        assert.strictEqual(r.display, null);
        assert.strictEqual(r.hiddenCount, true);
    });

    await it('refuses a URL shape it cannot resolve in one call', async () => {
        const { y, calls } = build('has ' + CODE);
        const r = await y.verifyOwnership('https://youtube.com/c/LegacyName', CODE);
        assert.strictEqual(r.reason, 'unsupported-url');
        assert.strictEqual(calls.length, 0);
    });

    await it('respects the daily budget, and counts against the same one', async () => {
        const { y } = build('has ' + CODE, null, { maxPerDay: 1 });
        assert.strictEqual((await y.verifyOwnership(CHANNEL, CODE)).ok, true);
        // Second call: budget spent. Not a silent success, and not a throw.
        assert.strictEqual((await y.verifyOwnership(CHANNEL, CODE)).reason, 'budget');
        assert.strictEqual(y.status().spentToday, 1);
    });

    await it('never throws at the caller when YouTube is down', async () => {
        const { y } = build('has ' + CODE, null, {
            fetchJson: async () => { throw new Error('down'); }
        });
        const r = await y.verifyOwnership(CHANNEL, CODE);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'unreachable');
    });

    await it('the API key never appears in anything it returns', async () => {
        const { y } = build('has ' + CODE);
        const r = await y.verifyOwnership(CHANNEL, CODE);
        assert.ok(!JSON.stringify(r).includes('test-key'), 'the key leaked into the response body');
    });
});

await describe('youtube -- the verification endpoint', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'apiRouter.js'), 'utf8');

    await it('takes the identity from the session, never from the body', async () => {
        // If the discord id could be posted, anybody could verify a
        // channel onto somebody else's account.
        assert.ok(/callRpc\('get_my_youtube_challenge', \{\}, req\.userToken\)/.test(src));
        assert.ok(/p_discord_id: challenge\.discordId/.test(src));
        assert.ok(!/req\.body\.(discordId|userId)/.test(src));
    });

    await it('writes the verdict with the service key, not the caller session', async () => {
        // record_youtube_verification is granted to service_role only.
        // Called through callRpc it would be refused -- and, worse, if it
        // were ever granted to `authenticated` the browser could call it
        // directly and skip this endpoint entirely.
        assert.ok(/callRpcAsService\('record_youtube_verification'/.test(src));
    });

    await it('requires a session at all', async () => {
        const route = src.indexOf("router.post('/youtube-verify'");
        assert.ok(route > 0, 'route missing');
        const line = src.slice(route, src.indexOf('\n', route));
        assert.ok(/requireUserToken/.test(line), 'the route is unauthenticated');
        assert.ok(/rateLimitVerify/.test(line), 'the route is unlimited');
    });

    await it('is registered before the Discord-readiness gate', async () => {
        // Nothing here touches Discord; a Render restart should not make
        // verification fail for the minute the gateway takes to reconnect.
        const route = src.indexOf("router.post('/youtube-verify'");
        const gate = src.indexOf('Bot is still starting up');
        assert.ok(route > 0 && gate > 0);
        assert.ok(route < gate, 'verification sits behind the gateway-readiness gate');
    });

    await it('answers 200 with a reason for every legitimate negative', async () => {
        // A 4xx would be indistinguishable from the auth failure, and the
        // page shows each of these differently.
        const route = src.slice(src.indexOf("router.post('/youtube-verify'"),
                                src.indexOf('// Without this, a request arriving'));
        assert.ok(/return res\.status\(200\)\.json\(\{ ok: false, reason: found\.reason \}\)/.test(route));
        assert.ok(/return res\.status\(200\)\.json\(\{ ok: false, reason: 'rejected'/.test(route));
    });

    await it('uses `error` on non-2xx, which is the key the browser reads', async () => {
        // _botFetch drops `message` on a non-2xx and substitutes "Bot
        // request failed", so any of these carrying `message` instead
        // would reach the user as that generic string.
        //
        // Two of the three live in the handler; the 429 is in
        // rateLimitVerify, which runs before it. Checked in both places
        // rather than widening the slice, so this cannot start passing
        // because it accidentally swallowed a neighbouring route.
        const route = src.slice(src.indexOf("router.post('/youtube-verify'"),
                                src.indexOf('// Without this, a request arriving'));
        const limiter = src.slice(src.indexOf('function rateLimitVerify'),
                                  src.indexOf('// Resolve the guild behind an invite link'));
        const replies = (route.match(/res\.status\((401|500)\)\.json\(\{[^}]*\}/g) || [])
            .concat(limiter.match(/res\.status\(429\)\.json\(\{[^}]*\}/g) || []);
        assert.strictEqual(replies.length, 3, 'expected three non-2xx replies, got ' + replies.length);
        replies.forEach(m => assert.ok(/error:/.test(m), 'non-2xx reply without an `error` key: ' + m));
    });

    await it('bounds the URL it will parse', async () => {
        const route = src.slice(src.indexOf("router.post('/youtube-verify'"));
        assert.ok(/url\.length > 300/.test(route.slice(0, 900)));
    });
});

await describe('youtube -- the endpoint in front of it', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'apiRouter.js'), 'utf8');

    await it('is registered before the Discord-readiness gate', () => {
        // This endpoint never touches Discord. Behind the gate, a Render
        // restart would 503 the badge for the minute the gateway takes to
        // reconnect, on pages that are otherwise fine.
        const route = src.indexOf("router.get('/youtube-subs'");
        const gate = src.indexOf('Bot is still starting up');
        assert.ok(route > 0 && gate > 0, 'route or gate missing');
        assert.ok(route < gate, 'the badge route sits behind the gateway-readiness gate');
    });

    await it('is rate limited', () => {
        assert.ok(/router\.get\('\/youtube-subs',\s*rateLimitPublic/.test(src),
            'no rate limiter on an unauthenticated endpoint');
    });

    await it('has a looser cap than the DM endpoints, but still a cap', () => {
        const m = src.match(/const PUBLIC_RATE_LIMIT_MAX = (\d+);/);
        assert.ok(m, 'PUBLIC_RATE_LIMIT_MAX not defined');
        const max = Number(m[1]);
        assert.ok(max > 20, 'a page-view endpoint capped at the DM rate would throttle ordinary reads');
        assert.ok(max <= 1000, 'effectively uncapped');
    });

    await it('bounds the URL it will parse', () => {
        assert.ok(/url\.length > 300/.test(src), 'accepts an unbounded string from an anonymous caller');
    });

    await it('answers 200 for every outcome, so a missing badge is not a console error', () => {
        const block = src.slice(src.indexOf("router.get('/youtube-subs'"));
        const body = block.slice(0, block.indexOf('\n    });'));
        assert.ok(/res\.status\(200\)\.json\(result\)/.test(body), 'the result is not returned as 200');
        assert.ok(!/res\.status\(5\d\d\)/.test(body), 'a 5xx leaks out of a decoration');
    });

    await it('lets the browser cache it too', () => {
        const block = src.slice(src.indexOf("router.get('/youtube-subs'"));
        assert.ok(/Cache-Control['"],\s*['"]public, max-age=\d+/.test(block.slice(0, 2000)),
            'no Cache-Control, so every navigation re-asks the bot');
    });

    await it('reads the key from the environment and never returns it', () => {
        assert.ok(/apiKey: process\.env\.YOUTUBE_API_KEY/.test(src), 'key not sourced from env');
        assert.ok(!/console\.log\([^)]*YOUTUBE_API_KEY/.test(src), 'the key is logged');
        assert.ok(!/res\.json\([^)]*YOUTUBE_API_KEY/.test(src), 'the key is returned to a caller');
    });
});

console.log('\n' + '='.repeat(60));
console.log(passed + ' passed, ' + failed + ' failed');
console.log('='.repeat(60));
// exitCode, not exit(): let the loop drain so the status reflects the tests
// rather than whatever handle happened to still be closing.
process.exitCode = failed ? 1 : 0;

})();
