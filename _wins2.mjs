import { createComputerUseServer } from '@zavora-ai/computer-use-mcp';
import { connectInProcess } from '@zavora-ai/computer-use-mcp/client';
const c = await connectInProcess(createComputerUseServer());
const w = await c.callTool('list_windows', { bundle_id: 'chrome.exe' });
const m = w.content.map(p=>p.text||'').join('\n').match(/\{[\s\S]*\}/);
const j = JSON.parse(m[0]);
(j.windows||[]).forEach(x=>console.log(x.windowId, JSON.stringify(x.bounds), x.title));
await c.close();
