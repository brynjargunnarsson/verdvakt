// Sendir prufutilkynningu (hnappur á síðunni → Stillingar).
import { sendNtfy } from './alerts.js';

const res = await sendNtfy({ title: 'Verðvakt: prufa', message: 'Ef þú sérð þetta virka tilkynningar. 🎉' });
console.log(res.sent ? 'Prufutilkynning send.' : `Ekki send: ${res.reason}`);
if (!res.sent) process.exitCode = 1;
