import { createComputerUseServer } from '@zavora-ai/computer-use-mcp';
import { connectInProcess } from '@zavora-ai/computer-use-mcp/client';
import fs from 'fs';
const c = await connectInProcess(createComputerUseServer());
const wins = await c.callTool('list_windows', { bundle_id: 'chrome.exe' });
const m = wins.content.map(p=>p.text||'').join('\n').match(/\[[\s\S]*\]/);
const arr = JSON.parse(m[0]);
const w = arr.find(x => /bitwarden/i.test(x.title || '')) || arr.find(x => String(x.windowId) === process.argv[2]);
if (!w) { console.log('no bitwarden window'); await c.close(); process.exit(1); }
console.log('shooting', w.windowId, w.title);
const ws = await c.screenshot({ width: 1280, target_window_id: w.windowId });
const img = ws.content.find(p=>p.type==='image');
fs.writeFileSync('_bw.jpg', Buffer.from(img.data,'base64'));
console.log('bytes', img.data.length);
await c.close();
