const bw = await import('./lib/bitwarden.js');
const ok = await bw.repairTemplate(() => false);
console.log('repair result:', ok);
process.exit(0);
