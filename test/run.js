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

    await it('a plain date still parses (used by /tournaments startDate)', () => {
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

    await it('defaults to production when unset', () => {
        delete require.cache[modPath];
        delete process.env.SITE_URL;
        const url = require(modPath).SITE_URL;
        assert.ok(/^https:\/\/\S+$/.test(url) && url.charAt(url.length - 1) !== '/', 'got: ' + url);
    });

    if (saved === undefined) delete process.env.SITE_URL; else process.env.SITE_URL = saved;
    delete require.cache[modPath];
});

console.log('\n' + '='.repeat(60));
console.log(passed + ' passed, ' + failed + ' failed');
console.log('='.repeat(60));
// exitCode, not exit(): let the loop drain so the status reflects the tests
// rather than whatever handle happened to still be closing.
process.exitCode = failed ? 1 : 0;

})();
