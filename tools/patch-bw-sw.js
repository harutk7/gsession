// One-time, idempotent patcher for extensions/bitwarden/background.js (MV3 SW).
// Injects __gswLog calls that forward key FIDO2 relay events to the gsession
// server (POST /api/debug/sw-log) so we can see what the SW does when the
// passkeys page calls navigator.credentials.create().
import fs from 'fs';
import path from 'path';

import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'extensions', 'bitwarden', 'background.js');
let s = fs.readFileSync(FILE, 'utf8');

if (s.includes('__gswLog')) {
  console.log('already patched, nothing to do');
  process.exit(0);
}

const patches = [
  // 0. global log helper (prepended, self-contained IIFE)
  {
    anchor: null, // special: prepend
    replacement:
      "(function(){globalThis.__gswLog=(m)=>{try{fetch('http://localhost:3002/api/debug/sw-log',{method:'POST',mode:'no-cors',body:String(m)})}catch(e){}};})();",
  },
  // A. Fido2ExtensionMessageHandler.handleExtensionMessage (the one with the
  //    fido2RegisterCredentialRequest shape check) — log entry, shape-drop, outcome
  {
    anchor:
      'if(!("fido2RegisterCredentialRequest"!==(null==e?void 0:e.command)&&"fido2GetCredentialRequest"!==(null==e?void 0:e.command)||null!=t.tab&&null!=e.requestId&&null!=e.data))return i(void 0),!0;const n=r({message:e,sender:t});return void 0!==n?(Promise.resolve(n).then(e=>i(e),e=>i({error:Object.assign(Object.assign({},e),{message:e.message})})).catch(this.logService.error),!0):void 0}',
    replacement:
      'if(!("fido2RegisterCredentialRequest"!==(null==e?void 0:e.command)&&"fido2GetCredentialRequest"!==(null==e?void 0:e.command)||null!=t.tab&&null!=e.requestId&&null!=e.data)){try{__gswLog(\'extmsg-dropped:\'+__cmd+\' hasTab=\'+!!(t&&t.tab)+\' hasReqId=\'+!!(e&&e.requestId)+\' hasData=\'+!!(e&&e.data))}catch(_){}return i(void 0),!0;}const n=r({message:e,sender:t});return void 0!==n?(Promise.resolve(n).then(e=>{try{__gswLog(\'extmsg-resolve:\'+__cmd)}catch(_){}i(e)},e=>{try{__gswLog(\'extmsg-reject:\'+__cmd+\':\'+String((e&&e.message)||e).slice(0,150))}catch(_){}i({error:Object.assign(Object.assign({},e),{message:e.message})})}).catch(this.logService.error),!0):void 0}',
  },
  // A0. entry log for the same handler (anchored on the fido2-specific shape
  //     check being preceded by this exact prefix — unique pair)
  {
    anchor:
      'this.handleExtensionMessage=(e,t,i)=>{const r=this.extensionMessageHandlers[null==e?void 0:e.command];if(!r)return;if(!("fido2RegisterCredentialRequest"!==(null==e?void 0:e.command)',
    replacement:
      'this.handleExtensionMessage=(e,t,i)=>{const __cmd=((e&&e.command)||\'?\');try{__gswLog(\'extmsg:\'+__cmd+\' tab=\'+((t&&t.tab&&t.tab.id)?t.tab.id:\'no-tab\')+\' url=\'+((t&&t.tab&&t.tab.url)||\'\').slice(0,90))}catch(_){}const r=this.extensionMessageHandlers[null==e?void 0:e.command];if(!r){try{__gswLog(\'extmsg-nohandler:\'+__cmd)}catch(_){}return;}if(!("fido2RegisterCredentialRequest"!==(null==e?void 0:e.command)',
  },
  // B. injected-script port: log whether FIDO2 feature gate passed
  {
    anchor: 'if(!(yield this.fido2ClientService.isFido2FeatureEnabled(t,i)))return void e.disconnect();',
    replacement:
      'const __en=yield this.fido2ClientService.isFido2FeatureEnabled(t,i);try{__gswLog(\'fido2-port url=\'+e.sender.url+\' enabled=\'+__en)}catch(_){}if(!__en)return void e.disconnect();',
  },
  // C. Fido2ClientService.createCredential: entry + feature-check throw.
  //    The throw is a comma-expression statement ("throw a, new t_;"), so the
  //    anchor must extend through "new t_;" for the wrapping block to close.
  {
    anchor: 'if(!(yield this.isFido2FeatureEnabled(y.hostname,e.origin)))throw null===(r=this.logService)||void 0===r||r.warning("[Fido2Client] Fido2VaultCredential is not enabled"),new t_;',
    replacement:
      '{try{__gswLog(\'createCredential origin=\'+e.origin+\' sameOrigin=\'+e.sameOriginWithAncestors+\' rpId=\'+(e.rpId||\'?\'))}catch(_){}}if(!(yield this.isFido2FeatureEnabled(y.hostname,e.origin))){try{__gswLog(\'cc-throw:feature-disabled\')}catch(_){}throw null===(r=this.logService)||void 0===r||r.warning("[Fido2Client] Fido2VaultCredential is not enabled"),new t_;}',
  },
  // D. Fido2ClientService.assertCredential: feature-check throw (same shape)
  {
    anchor: 'if(!(yield this.isFido2FeatureEnabled(p.hostname,e.origin)))throw null===(r=this.logService)||void 0===r||r.warning("[Fido2Client] Fido2VaultCredential is not enabled"),new t_;',
    replacement:
      '{try{__gswLog(\'assertCredential origin=\'+e.origin)}catch(_){}}if(!(yield this.isFido2FeatureEnabled(p.hostname,e.origin))){try{__gswLog(\'ac-throw:feature-disabled\')}catch(_){}throw null===(r=this.logService)||void 0===r||r.warning("[Fido2Client] Fido2VaultCredential is not enabled"),new t_;}',
  },
  // E. BrowserFido2UserInterfaceService.confirmNewCredential: send + response
  {
    anchor:
      'const a={type:"ConfirmNewCredentialRequest",sessionId:this.sessionId,credentialName:e,userName:t,userHandle:i,userVerification:r,fallbackSupported:this.fallbackSupported,rpId:n};yield this.send(a);const s=yield this.receive(TR);return{cipherId:s.cipherId,userVerified:s.userVerified}}',
    replacement:
      'const a={type:"ConfirmNewCredentialRequest",sessionId:this.sessionId,credentialName:e,userName:t,userHandle:i,userVerification:r,fallbackSupported:this.fallbackSupported,rpId:n};try{__gswLog(\'confirmNewCredential rpId=\'+n+\' name=\'+(e||\'?\')+\' uv=\'+r)}catch(_){}yield this.send(a);const s=yield this.receive(TR);try{__gswLog(\'confirmNewCredential-resp cipherId=\'+(s&&s.cipherId)+\' userVerified=\'+(s&&s.userVerified))}catch(_){}return{cipherId:s.cipherId,userVerified:s.userVerified}}',
  },
];

for (const p of patches) {
  if (p.anchor === null) {
    s = p.replacement + s;
    continue;
  }
  const i = s.indexOf(p.anchor);
  if (i < 0) {
    console.error('ANCHOR NOT FOUND:', p.anchor.slice(0, 80));
    process.exit(1);
  }
  if (s.indexOf(p.anchor, i + 1) >= 0) {
    console.error('ANCHOR NOT UNIQUE:', p.anchor.slice(0, 80));
    process.exit(1);
  }
  s = s.slice(0, i) + p.replacement + s.slice(i + p.anchor.length);
  console.log('patched at', i, ':', p.anchor.slice(0, 60).replace(/\n/g, ' '));
}

fs.writeFileSync(FILE, s);
console.log('done. file size now', s.length);
