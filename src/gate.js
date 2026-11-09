// Cheap check run by the workflow before installing anything:
// prints run=true/false to $GITHUB_OUTPUT.
import { appendFileSync } from 'node:fs';
import { readJson } from './util.js';
import { isDue, activeEvent } from './schedule.js';

const state = await readJson('state.json', {});
const sale = await readJson('sale-days.json', {});
const products = (await readJson('products.json', { products: [] })).products;
const pendingSearch = products.some((p) => !state.lastDiscovery?.[p.id]);

const force = process.env.FORCE === 'true';
const run = force || pendingSearch || isDue(state, sale);
const ev = activeEvent(sale);
const msg = `run=${run}\n`;
console.log(`Síðast keyrt: ${state.lastRun || 'aldrei'} · ${ev ? 'Afsláttartímabil: ' + ev.name : 'venjulegt tímabil'} · ${msg}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, msg);
