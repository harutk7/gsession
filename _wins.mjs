import { createComputerUseServer } from '@zavora-ai/computer-use-mcp';
import { connectInProcess } from '@zavora-ai/computer-use-mcp/client';
const c = await connectInProcess(createComputerUseServer());
const r = await c.callTool('list_windows', { bundle_id: 'chrome.exe' });
console.log((r.content||[]).map(p=>p.text).join('\n'));
