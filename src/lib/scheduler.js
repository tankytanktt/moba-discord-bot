/**
 * A scheduler that lives inside the bot process.
 *
 * WHY NOT GITHUB ACTIONS. That was the first attempt, and it is still in
 * .github/workflows/scrim-reminders.yml with its `schedule:` trigger
 * removed. GitHub deprioritizes scheduled workflows on low-activity
 * repositories: a 5-minute cron fired every 3-4 hours in practice, so
 * scrims went unreminded and the feature was replaced by a manual button.
 * A timer in a process that is already running has no such queue to sit
 * in -- it fires when it says it will.
 *
 * WHY THIS PROCESS. The bot is already long-lived and already kept awake
 * by an uptime pinger hitting /health. If it is up enough to answer a
 * slash command, it is up enough to run a timer. No new service, no new
 * bill, no new secret.
 *
 * WHAT THIS MODULE REFUSES TO DO
 *   - Stack runs. A job still working when its next turn arrives is
 *     skipped, not queued behind itself. Two copies of a reminder sweep
 *     racing each other is how you send everything twice.
 *   - Let one job kill the process. Every run is wrapped: a throwing job
 *     is recorded and the others carry on. This bot has been taken down
 *     by exactly one unhandled rejection before (see callRpcAsService in
 *     src/api/apiRouter.js), and a scheduler that can repeat that is
 *     worse than no scheduler.
 *   - Fail quietly. The whole reason the first attempt went unnoticed for
 *     so long is that nothing reported it was under-firing. status() is
 *     surfaced on /health so a stalled or erroring job is visible from
 *     the outside, by a monitor, without reading logs.
 *
 * Jobs must be IDEMPOTENT. Nothing here guarantees exactly-once: a
 * restart mid-run, or an external cron hitting the same endpoint, must be
 * harmless. The scrim sweep gets this from `reminderSentAt is null` in
 * get_scrims_needing_reminder().
 */

// Injectable so tests do not wait on wall-clock time. Everything below
// takes `now` in milliseconds and never calls Date.now() directly.
function createScheduler(options) {
    const opts = options || {};
    const now = opts.now || (() => Date.now());
    const log = opts.log || console.log;
    const jobs = [];
    let timer = null;
    let started = false;

    /**
     * name     identifies the job in status() and in logs
     * everyMs  how often to run it
     * run      async () => any; may throw, and is expected to be idempotent
     * enabled  optional () => boolean, checked at each due time. Used to
     *          skip work that cannot succeed yet (a dead Discord gateway)
     *          WITHOUT counting it as a failure -- see the note in
     *          jobs/scrimReminders.js about why a skipped run matters.
     */
    function register(job) {
        if (!job || !job.name || typeof job.run !== 'function') {
            throw new Error('scheduler.register needs { name, everyMs, run }');
        }
        if (jobs.some(j => j.name === job.name)) {
            throw new Error('scheduler: duplicate job name ' + job.name);
        }
        const everyMs = Math.max(1000, job.everyMs || 60000);
        jobs.push({
            name: job.name,
            everyMs: everyMs,
            run: job.run,
            enabled: job.enabled || null,
            // First run is one full interval away rather than immediate:
            // startup is the busiest, least stable moment in this process
            // (gateway handshake, command registration), and a sweep that
            // fires into that has the worst chance of succeeding.
            nextRunAt: now() + everyMs,
            running: false,
            runs: 0,
            failures: 0,
            skips: 0,
            lastRunAt: null,
            lastOkAt: null,
            lastError: null,
            lastDurationMs: null,
            lastResult: null
        });
        return this;
    }

    // Runs every job that is due. Separate from start() precisely so it
    // can be called directly -- by a test, or by the HTTP endpoint that
    // exists for a manual poke -- without a real timer involved.
    async function runDue() {
        const t = now();
        // A snapshot: a job registered while this loop is awaiting must
        // not be picked up halfway through the same pass.
        const due = jobs.filter(j => j.nextRunAt <= t);
        for (const job of due) {
            await runJob(job);
        }
        return due.length;
    }

    async function runJob(job) {
        // Overlap guard. Note the schedule still advances -- a job that
        // takes longer than its interval settles into running
        // back-to-back rather than accumulating a backlog it can never
        // clear.
        if (job.running) {
            job.skips++;
            job.nextRunAt = now() + job.everyMs;
            log('[scheduler] ' + job.name + ' still running, skipping this turn');
            return;
        }
        if (job.enabled && !job.enabled()) {
            job.skips++;
            job.nextRunAt = now() + job.everyMs;
            return;
        }

        job.running = true;
        const startedAt = now();
        job.lastRunAt = startedAt;
        try {
            const result = await job.run();
            job.runs++;
            job.lastOkAt = now();
            // Kept for /health. Jobs return small summaries, never the
            // records themselves -- this is read by an uptime monitor,
            // not a debugger, and must not become a data leak.
            job.lastResult = summarize(result);
            job.lastError = null;
        } catch (e) {
            job.failures++;
            // Message only. A stack trace on a health endpoint tells an
            // unauthenticated reader about the filesystem.
            job.lastError = (e && e.message) ? String(e.message).slice(0, 200) : 'unknown error';
            log('[scheduler] ' + job.name + ' FAILED: ' + job.lastError);
        } finally {
            job.running = false;
            job.lastDurationMs = now() - startedAt;
            // Scheduled from the END of the run, not the start: a job that
            // overruns its interval would otherwise be permanently due.
            job.nextRunAt = now() + job.everyMs;
        }
    }

    // Only plain, small values reach /health.
    function summarize(result) {
        if (result === null || result === undefined) return null;
        if (typeof result === 'number' || typeof result === 'string' || typeof result === 'boolean') {
            return result;
        }
        const out = {};
        Object.keys(result).slice(0, 8).forEach(k => {
            const v = result[k];
            if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') {
                out[k] = typeof v === 'string' ? v.slice(0, 80) : v;
            }
        });
        return out;
    }

    // tickMs is the resolution of the whole scheduler, not any job's
    // interval: every job's own everyMs is honoured by nextRunAt above.
    function start(tickMs) {
        if (started) return;
        started = true;
        const every = Math.max(1000, tickMs || 30000);
        timer = setInterval(() => {
            // runDue never rejects (runJob swallows per job), but an
            // unhandled rejection here would take the whole bot down, so
            // this is belt and braces rather than trust.
            runDue().catch(e => log('[scheduler] tick error: ' + (e && e.message)));
        }, every);
        // Do not hold the process open on this timer alone.
        if (timer.unref) timer.unref();
        log('[scheduler] started -- ' + jobs.length + ' job(s), ticking every ' + Math.round(every / 1000) + 's');
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
        started = false;
    }

    // Shaped for a monitor, not a human: `stalled` is the single field
    // worth alerting on, so nobody has to derive it from timestamps.
    function status() {
        const t = now();
        return {
            started: started,
            jobs: jobs.map(j => ({
                name: j.name,
                everyMs: j.everyMs,
                runs: j.runs,
                failures: j.failures,
                skips: j.skips,
                running: j.running,
                lastRunAt: j.lastRunAt ? new Date(j.lastRunAt).toISOString() : null,
                lastOkAt: j.lastOkAt ? new Date(j.lastOkAt).toISOString() : null,
                lastError: j.lastError,
                lastDurationMs: j.lastDurationMs,
                lastResult: j.lastResult,
                nextRunInMs: Math.max(0, j.nextRunAt - t),
                // True when a job has missed its slot by more than two
                // whole intervals -- the condition the GitHub cron was in
                // for weeks without anyone noticing.
                stalled: started && j.lastRunAt !== null && (t - j.lastRunAt) > (j.everyMs * 3)
            }))
        };
    }

    return { register, runDue, start, stop, status, get size() { return jobs.length; } };
}

module.exports = { createScheduler };
