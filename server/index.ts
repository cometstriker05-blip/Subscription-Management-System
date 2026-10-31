import { serve } from '@hono/node-server';
import { app } from './app.ts';
import { migrate } from './db/migrate.ts';
import { appState } from './services/core.ts';
import { runDay } from './services/daily.ts';
import { pool } from './db/pool.ts';
import { addDays } from './engine/index.ts';

// The database may still be starting or recovering, so give it a minute before giving up.
for (let attempt = 1; ; attempt++) {
  try {
    await migrate();
    break;
  } catch (err) {
    if (attempt >= 30) throw err;
    console.log(`Waiting for the database (${attempt})`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

// A stray failure in a background job must never take the whole server down.
process.on('unhandledRejection', (err) => console.error('Unhandled rejection', err));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`Keel API listening on http://localhost:${port}`);

/** In live mode the business clock follows the calendar. Catches up after any downtime. */
async function liveTick() {
  try {
    const state = await appState();
    if (state.clockMode !== 'live') return;
    const real = new Date().toISOString().slice(0, 10);
    let day = state.today;
    while (day < real) {
      day = addDays(day, 1);
      await pool.query(`UPDATE app_state SET today = $1 WHERE id = 1`, [day]);
      await runDay(day, { simulate: false, holdBilling: false, emit: (e) => console.log(e.date, e.message) });
    }
  } catch (err) {
    console.error('Live tick failed', err);
  }
}
setInterval(liveTick, 60_000).unref();
