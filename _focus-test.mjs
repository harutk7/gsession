import { createComputerUseServer } from '@zavora-ai/computer-use-mcp';
import { connectInProcess } from '@zavora-ai/computer-use-mcp/client';
import fs from 'fs';
const c = await connectInProcess(createComputerUseServer());
const w = await c.callTool('list_windows', { bundle_id: 'chrome.exe' });
const m = w.content.map(p=>p.text||'').join('\n').match(/\{[\s\S]*\}/);
const j = JSON.parse(m[0]); const win = j.windows[0];
console.log('window', win.windowId, JSON.stringify(win.bounds));
// 1. activate the window
const act = await c.callTool('activate_window', { window_id: win.windowId });
console.log('activate:', act.content.map(p=>p.text||'').join(' ').slice(0,150));
await new Promise(r=>setTimeout(r,800));
// 2. click email field (screen coords: window at -8,-8; field at ~ (855,269) in window px)
const cx = win.bounds.x + 855, cy = win.bounds.y + 269;
const cl = await c.callTool('left_click', { coordinate: [cx, cy] });
console.log('click:', cl.content.map(p=>p.text||'').join(' ').slice(0,120));
await new Promise(r=>setTimeout(r,500));
// 3. type
const ty = await c.callTool('type', { text: 'focustest', target_window_id: win.windowId, focus_strategy: 'best_effort' });
console.log('type:', ty.content.map(p=>p.text||'').join(' ').slice(0,120));
await new Promise(r=>setTimeout(r,800));
// 4. capture
const shot = await c.screenshot({ target_window_id: win.windowId });
const img = shot.content.find(p => p.type === 'image');
fs.writeFileSync('_focustest.jpg', Buffer.from(img.data, 'base64'));
console.log('saved _focustest.jpg');
await c.close();
