import {afterEach,expect,it,vi} from 'vitest';
import {parseListeners,discoverLocalServers} from './localServers';
vi.mock('node:child_process',async()=>{const {promisify}=await import('node:util');return {execFile:Object.assign(vi.fn(),{[promisify.custom]:async()=>({stdout:'p1\ncnode\nn*:5173\nn127.0.0.1:9225\nn[::1]:7000\n'})})};});
afterEach(()=>vi.unstubAllGlobals());
it('deduplicates local ports and excludes LAN-only listeners and invalid ports',()=>{
  expect(parseListeners('p1\ncnode\nn*:5173\nn[::1]:5173\nn192.168.1.2:8000\nn*:70000\np2\ncPython\nn127.0.0.1:8080')).toEqual([{url:'http://localhost:5173',port:5173,processName:'node'},{url:'http://localhost:8080',port:8080,processName:'Python'}]);
});
it('only publishes successful HTML endpoints, without following redirects',async()=>{
  const fetcher=vi.fn(async(url:string)=>new Response(null,{status:url.includes('7000')?302:200,headers:{'content-type':url.includes('5173')?'text/html':'application/json'}}));vi.stubGlobal('fetch',fetcher);
  expect(await discoverLocalServers()).toEqual([{url:'http://localhost:5173',port:5173,processName:'node'}]);
  expect(fetcher).toHaveBeenCalledWith('http://localhost:9225',expect.objectContaining({method:'HEAD',redirect:'manual'}));
});
