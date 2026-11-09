// When should the watcher run, and how thoroughly?

export function activeEvent(sale, now = new Date()) {
  const before = (sale.windowBeforeHours ?? 12) * 3600e3;
  const after = (sale.windowAfterHours ?? 24) * 3600e3;
  for (const ev of sale.events || []) {
    const s = Date.parse(ev.start + 'T00:00:00Z') - before;
    const e = Date.parse((ev.end || ev.start) + 'T23:59:59Z') + after;
    if (now >= s && now <= e) return ev;
  }
  return null;
}

/** Is `now` on one of the event's actual days (not just the window around it)? */
export function onEventDay(sale, now = new Date()) {
  const d = now.toISOString().slice(0, 10);
  return (sale.events || []).find((ev) => d >= ev.start && d <= (ev.end || ev.start)) || null;
}

export function intervalMinutes(sale, now = new Date()) {
  return activeEvent(sale, now) ? sale.saleIntervalMin ?? 30 : (sale.normalIntervalHours ?? 3) * 60;
}

/** Decide whether a scheduled run is due. 8 minute slack because GitHub cron is late. */
export function isDue(state, sale, now = new Date()) {
  if (!state?.lastRun) return true;
  const mins = (now - Date.parse(state.lastRun)) / 60e3;
  return mins >= intervalMinutes(sale, now) - 8;
}
