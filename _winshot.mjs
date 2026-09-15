import { createComputerUseServer } from '@zavora-ai/computer-use-mcp';
import { connectInProcess } from '@zavora-ai/computer-use-mcp/client';
import fs from 'fs';
const c = await connectInProcess(createComputerUseServer());
const wins = await c.callTool('list_windows', { bundle_id: 'chrome.exe' });
const m = wins.content.map(p=>p.text||'').join('\n').match(/\[[\s\S]*\]/);
const arr = JSON.parse(m[0]); const chrome = arr[0];
console.log('chrome window', chrome.windowId, chrome.title, JSON.stringify(chrome.bounds));
// full screen
const full = (await c.screenshot({width:1280})).content.find(p=>p.type==='image');
fs.writeFileSync('_full.jpg', Buffer.from(full.data,'base64'));
// window-targeted
try {
  const ws = await c.screenshot({ width: 1280, target_window_id: chrome.windowId });
  const img = ws.content.find(p=>p.type==='image');
  fs.writeFileSync('_win.jpg', Buffer.from(img.data,'base64'));
  console.log('window-targeted bytes:', img.data.length);
  console.log('window-targeted text:', (ws.content.find(p=>p.type==='text')||{}).text?.split('\n').slice(0,2).join(' | '));
} catch(e){ console.log('window-targeted failed:', e.message); }
// avg brightness helper
import { execFileSync } from 'child_process';
await c.close();
