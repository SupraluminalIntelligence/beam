// Real UI, isolated fixtures: no Convex connection and no messages to teammates.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "../apps/web/node_modules/vite/dist/node/index.js";
import react from "../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../apps/web/", import.meta.url));
const dir = await mkdtemp(`${root}.notifications-check-`);
const mock = `${dir}/convex.ts`;
await writeFile(mock, `
import { useSyncExternalStore } from 'react';
import { getFunctionName } from 'convex/server';
const subscribers = new Set<()=>void>();
const empty: any[] = [], object = {};
const prefs = { enabled:true,mention:true,completed:true,failed:true,input:true,sound:true };
const people = { apek:{name:'apekshik'}, 'noah-dev':{name:'Noah Example'} };
let messages = Array.from({length:70},(_,i)=>({_id:'m'+i,_creationTime:Date.now()-70000+i*1000,chatId:'chat',author:'apek',kind:'text',text:i===5?'@noah-dev Please review this exact message.':'Context message '+i,runId:null,reactions:[],attachments:[]}));
let rows:any[] = [], version = 0;
let machine = {id:"runner",name:"apek@host",hostname:"host.local",online:true};
const emit=()=>{version++;subscribers.forEach(f=>f());};
window.fixture={sendFail:false,renameFail:false,incoming:()=>{messages=[...messages,{...messages[0],_id:"incoming",_creationTime:Date.now(),text:"Incoming update"}];emit();},calls:[],banners:[],fail:false,add:(id='mention')=>{rows=[...rows,{_id:id,_creationTime:Date.now(),kind:'mention',recipient:'noah-dev',chatId:'chat',workspaceId:'ws',messageId:'m5',title:'Apekshik mentioned you',body:'Design: Please review this exact message.',readAt:null,deliveredAt:null}];emit();},rows:()=>rows};
export function useQuery(fn:any,args:any){useSyncExternalStore(f=>{subscribers.add(f);return()=>subscribers.delete(f);},()=>version);if(args==='skip')return undefined;switch(getFunctionName(fn)){
case 'runners:mine':return [machine];case 'notifications:inbox':return rows;case 'notifications:preferences':return prefs;case 'messages:list':return messages;case 'users:byLogins':return people;case 'runs:eventsForChat':return object;case 'compute:studyContext':return null;default:return empty;}}
const mutations=new Map();
export function useMutation(fn:any){const name=getFunctionName(fn);if(!mutations.has(name))mutations.set(name,async(args:any)=>{window.fixture.calls.push({name,args});if(name==='runners:rename'){if(window.fixture.renameFail)throw new Error('Rename failed');machine={...machine,name:args.name};emit();return;}if(name==='messages:send'){if(window.fixture.sendFail)throw new Error('Send failed');messages=[...messages,{...messages[0],_id:'sent'+messages.length,_creationTime:Date.now(),text:args.text}];emit();return {kind:'text'};}const row=rows.find(r=>r._id===args.id);if(name==='notifications:reserve'){if(!row||row.deliveredAt!==null||row.token)return false;row.token=args.token;return true;}if(name==='notifications:finishDelivery'){if(row?.token===args.token){if(args.accepted)row.deliveredAt=Date.now();delete row.token;emit();}}if(name==='notifications:read'){row.readAt=Date.now();emit();}});return mutations.get(name);}
`);
await writeFile(`${dir}/entry.tsx`, `
import React from 'react';import {createRoot} from 'react-dom/client';
import {useQuery} from 'convex/react';import {api} from '../../../convex/_generated/api';import {MachineNameSetting} from '../src/components/MachineNameSetting';
import {Notifications} from '../src/components/Notifications';import {ChatView} from '../src/components/ChatView';
import {ui,useUi} from '../src/lib/ui';import './convex';import '../src/tokens.css';import '../src/app.css';
window.beam={platform:'darwin',notify:async n=>{window.fixture.banners.push(n);return !window.fixture.fail;},onNotificationClick:cb=>{window.fixture.click=cb;return()=>{};}};
window.fixture.ui=ui;ui.openChat('ws','other');
const chat={_id:'chat',_creationTime:Date.now()-70000,workspaceId:'ws',title:'Design review',private:false,members:['apek','noah-dev'],repos:[]};
function App(){const state=useUi();const machines=useQuery(api.runners.mine);return <div style={{height:'100vh',display:'flex',flexDirection:'column'}}><div style={{height:55,padding:12}}><Notifications activeChat={state.active.ws}/></div><MachineNameSetting runner={machines[0]} local/><div className="thread" style={{flex:1,minHeight:0}}><ChatView me={{githubLogin:'noah-dev',name:'Noah Example'}} chat={chat} detail={{id:'ws',name:'Design',repos:[],members:['apek','noah-dev'],agents:[]}} logins={new Set(['apek','noah-dev'])} setModal={()=>{}}/></div></div>};createRoot(document.getElementById('root')).render(<App/>);
`);
await writeFile(`${dir}/index.html`, '<!doctype html><html><body><div id="root"></div><script type="module" src="./entry.tsx"></script></body></html>');
let server, browser;
try {
  server = await createServer({ root, configFile:false, cacheDir:`${dir}/cache`, optimizeDeps:{entries:[`${dir}/index.html`]}, plugins:[react()], resolve:{alias:[{find:/^convex\/react$/,replacement:mock}]}, server:{host:'127.0.0.1',port:0}, logLevel:'error' });
  await server.listen();
  browser = await chromium.launch({ executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true });
  const page = await browser.newPage({viewport:{width:1200,height:850}}), errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/${dir.split('/').at(-1)}/index.html`);
  await page.locator('[data-mid="m69"]').waitFor();
  await page.evaluate(()=>window.fixture.add());
  await page.waitForFunction(()=>window.fixture.banners.length===1&&window.fixture.rows()[0].deliveredAt!==null);
  const banner = await page.evaluate(()=>window.fixture.banners[0]);
  assert.equal(banner.messageId,'m5'); assert.equal(banner.silent,false);
  await page.getByRole('button',{name:'Notifications, 1 unread'}).click();
  await page.getByRole('button',{name:/Apekshik mentioned you/}).click();
  await page.locator('[data-mid="m5"].notification-target').waitFor();
  const position=await page.evaluate(()=>{const el=document.querySelector('[data-mid="m5"]'),v=document.querySelector('.msgs');return {message:el.getBoundingClientRect().top,top:v.getBoundingClientRect().top,bottom:v.getBoundingClientRect().bottom,read:window.fixture.rows()[0].readAt};});
  assert(position.message>=position.top&&position.message<position.bottom);assert(position.read!==null);
  await page.waitForFunction(()=>!document.querySelector('.notification-target'),null,{timeout:7000});
  // A mention in the focused chat remains unread, but does not play a second sound.
  await page.evaluate(()=>window.fixture.add('focused'));
  await page.waitForFunction(()=>window.fixture.rows()[1].deliveredAt!==null);
  assert.equal(await page.evaluate(()=>window.fixture.banners.length),1);
  assert.equal(await page.evaluate(()=>window.fixture.rows()[1].readAt),null);
  // Banner navigation and visible highlight use the same message target.
  await page.evaluate(()=>window.fixture.click({...window.fixture.banners[0],id:'focused'}));
  await page.locator('[data-mid="m5"].notification-target').waitFor();
  // Username search inserts the chosen Beam username instead of requiring its GitHub login.
  await page.locator('textarea').fill('@Apek');
  await page.getByRole('button',{name:/apekshik member/}).click();
  assert.equal(await page.locator('textarea').inputValue(),'@apekshik ');
  // Sending from history resumes smooth following; incoming messages alone must not.
  const viewport=page.locator('.msgs');
  await viewport.evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event('scroll'));});
  await page.evaluate(()=>window.fixture.incoming());
  await page.waitForTimeout(150);
  assert.equal(await viewport.evaluate(el=>el.scrollTop),0);
  await page.locator('textarea').fill('Sent from history');
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  await page.waitForFunction(()=>{const el=document.querySelector('.msgs');return el.scrollHeight-el.clientHeight-el.scrollTop<3;});
  await viewport.evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event('scroll'));});
  await page.evaluate(()=>{window.fixture.sendFail=true;});
  await page.locator('textarea').fill('Keep this failed draft');
  await page.locator('textarea').press('Enter');
  await page.waitForFunction(()=>document.querySelector('textarea').value==='Keep this failed draft');
  assert.equal(await viewport.evaluate(el=>el.scrollTop),0);
  await page.evaluate(()=>{window.fixture.sendFail=false;});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.locator('textarea').press('Enter');
  await page.waitForFunction(()=>{const el=document.querySelector('.msgs');return el.scrollHeight-el.clientHeight-el.scrollTop<3;});
  const machineInput=page.getByLabel('This machine’s name');
  await machineInput.fill('Office Mac');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(await machineInput.inputValue(),'apek@host');
  await machineInput.fill('Apek’s MacBook Pro');
  await machineInput.press('Enter');
  await page.waitForFunction(()=>window.fixture.calls.some(c=>c.name==='runners:rename'&&c.args.name==='Apek’s MacBook Pro'));
  await page.getByRole('button',{name:'Save',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Save',exact:true}).isDisabled(),true);
  await page.evaluate(()=>{window.fixture.renameFail=true;});
  await machineInput.fill('Unsaved name');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Rename failed'}).waitFor();
  assert.equal(await machineInput.inputValue(),'Unsaved name');
  await page.screenshot({path:'/tmp/beam-0.1.6-controls.png'});
  assert.deepEqual(errors,[]);
  console.log('PASS: native payload, single delivery, inbox unread state, exact-message jump, highlight expiry, focused suppression, banner click, name picker, send-from-history scrolling, reduced motion, failed-send draft, machine rename/save/cancel/error; no live backend used.');
} finally { await browser?.close();await server?.close();await rm(dir,{recursive:true,force:true}); }
