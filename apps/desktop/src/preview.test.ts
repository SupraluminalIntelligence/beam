import { expect,it,vi } from 'vitest';
const preview={setPermissionRequestHandler:vi.fn(),setPermissionCheckHandler:vi.fn(),on:vi.fn()};
vi.mock('electron',()=>({session:{fromPartition:()=>preview}}));
import {installPreviewHost,previewUrlAllowed,PREVIEW_PARTITION} from './preview';
it('isolates guests from host privileges and rejects unsupported navigation',()=>{
  const handlers:Record<string,Function>={};const host={on:(name:string,fn:Function)=>{handlers[name]=fn;}};
  installPreviewHost(host as never);
  const event={preventDefault:vi.fn()};const prefs:any={preload:'/secret',nodeIntegration:true,contextIsolation:false,sandbox:false};
  handlers['will-attach-webview']!(event,prefs,{partition:PREVIEW_PARTITION,src:'https://example.com'});
  expect(event.preventDefault).not.toHaveBeenCalled();expect(prefs).toMatchObject({nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false});expect(prefs.preload).toBeUndefined();
  handlers['will-attach-webview']!(event,prefs,{partition:'persist:beam-auth',src:'https://example.com'});expect(event.preventDefault).toHaveBeenCalledOnce();
  for(const url of ['file:///etc/passwd','javascript:alert(1)','https://user:pass@example.com'])expect(previewUrlAllowed(url)).toBe(false);
});
