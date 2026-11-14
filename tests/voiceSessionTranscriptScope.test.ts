import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {setTimeout as wallTimer,clearTimeout as clearWallTimer} from 'node:timers';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DEFAULT_SETTINGS} from '../src/defaults';
const ws=vi.hoisted(()=>{
 class Socket{static OPEN=1;static CLOSED=3;readyState=0;sent:any[]=[];handlers=new Map<string,Function[]>();
 constructor(){sockets.push(this);state.constructed?.(this);}
 on(n:string,f:Function){this.handlers.set(n,[...(this.handlers.get(n)||[]),f]);return this;}
 prependListener(n:string,f:Function){this.handlers.set(n,[f,...(this.handlers.get(n)||[])]);return this;}
 off(n:string,f:Function){this.handlers.set(n,(this.handlers.get(n)||[]).filter(x=>x!==f));return this;}
 emit(n:string,...args:any[]){if(n==='open')this.readyState=1;if(n==='close')this.readyState=3;for(const f of [...(this.handlers.get(n)||[])])f(...args);}
 message(e:any){this.emit('message',Buffer.from(JSON.stringify(e)));}
 send(s:string){const p=JSON.parse(s);this.sent.push(p);state.sent?.(this,p);if(p.type==='session.update')queueMicrotask(()=>this.message({type:'session.updated',session:{...p.session,model:'synthetic-reported'}}));}
 close(){this.emit('close',1000,Buffer.alloc(0));}terminate(){this.close();}}
 const sockets:Socket[]=[],state:{constructed?:(s:Socket)=>void,sent?:(s:Socket,p:any)=>void}={};return{Socket,sockets,state};
});
vi.mock('ws',()=>({default:ws.Socket}));
vi.mock('obsidian',()=>({App:class{},Plugin:class{constructor(readonly app:any,readonly manifest:any){}},TFile:class{},TFolder:class{},WorkspaceLeaf:class{},ItemView:class{},Modal:class{},PluginSettingTab:class{},Setting:class{},Platform:{isDesktopApp:false},Notice:class{},setIcon:vi.fn(),normalizePath:(p:string)=>p.replace(/\\/g,'/').replace(/\/{2,}/g,'/'),requestUrl:vi.fn(()=>{throw Error('Forbidden external HTTP');})}));
const {default:LifeOpsPlugin}=await import('../src/main'),{LifeOpsView}=await import('../src/lifeOpsView'),{LifeOpsStore}=await import('../src/store'),{BailianRealtimeClient}=await import('../src/bailianRealtime'),{DiskVault}=await import('./helpers/diskVault');


let root:string,plugin:any,view:any,tracks:any[],contexts:any[],fetchGuard:any;
const wallTasks=new Set<ReturnType<typeof wallTimer>>();
const usage={input_tokens:528,output_tokens:37,total_tokens:565};
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{promise,resolve};}
beforeEach(async()=>{
 vi.useFakeTimers();
 const fakeSet=globalThis.setTimeout,fakeClear=globalThis.clearTimeout;
 vi.spyOn(globalThis,'setTimeout').mockImplementation(((callback:()=>void,delay?:number)=>{
  if(delay!==0)return Reflect.apply(fakeSet,globalThis,[callback,delay]);
  let handle:ReturnType<typeof wallTimer>;handle=wallTimer(()=>{wallTasks.delete(handle);callback();},0);wallTasks.add(handle);return handle;
 })as typeof setTimeout);
 vi.spyOn(globalThis,'clearTimeout').mockImplementation(((handle:ReturnType<typeof wallTimer>)=>{
  if(wallTasks.delete(handle))clearWallTimer(handle);else Reflect.apply(fakeClear,globalThis,[handle]);
 })as typeof clearTimeout);
 vi.stubGlobal('window',globalThis);ws.sockets.length=0;ws.state.constructed=undefined;ws.state.sent=undefined;tracks=[];contexts=[];
 fetchGuard=vi.fn(()=>{throw Error('No external fetch allowed');});vi.stubGlobal('fetch',fetchGuard);
 vi.stubGlobal('MediaRecorder',class{});
 vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:vi.fn(async()=>{const track={kind:'audio',readyState:'live',stop(){this.readyState='ended';}};tracks.push(track);return{getTracks:()=>[track]};})}});
 const node=()=>({connect:vi.fn(),disconnect:vi.fn(),gain:{value:1},onaudioprocess:null});
 vi.stubGlobal('AudioContext',class{state='running';sampleRate=16000;destination={};constructor(){contexts.push(this);}createMediaStreamSource=node;createScriptProcessor=node;createGain=node;async close(){this.state='closed';}});
 root=await mkdtemp(join(tmpdir(),'lifeops-app-accounting-'));const vault=new DiskVault(root),leaves:any[]=[],app:any={vault,workspace:{getLeavesOfType:()=>leaves}},settings=structuredClone(DEFAULT_SETTINGS);settings.ai.provider='off';settings.realtimeVoice={...settings.realtimeVoice,mode:'omni-e2e',apiKey:'synthetic-only',speakReplies:false,cloudFallback:false,dataDisclosureAccepted:true,plaintextCredentialStorageAccepted:true};settings.privacy!.plaintextCredentialStorageAccepted=true;
 const store=new LifeOpsStore(app,settings);await store.initializeVault();
 plugin=Object.assign(new LifeOpsPlugin(app,{id:'lifeops-assistant'} as never),{store,settings,unloaded:false,savedVoiceSettingsRevision:'synthetic-revision',appendQualityLog:vi.fn(async()=>{}),appendVoiceMetric:vi.fn(async()=>{})});
 view=new LifeOpsView({} as never,plugin);leaves.push({view});view.render=vi.fn(async()=>{});view.refreshAgentSurfaceState=vi.fn();view.appendVoiceMetric=vi.fn();view.appendAgentQualityLog=vi.fn(async()=>{});view.agentMode='voice';view.agentVoiceConversation=true;

});
afterEach(async()=>{view?.stopVoiceStandby();if(view)await view.stopBailianRealtimeRecording(true);await Promise.resolve();expect(wallTasks.size).toBe(0);vi.clearAllTimers();vi.restoreAllMocks();vi.useRealTimers();vi.unstubAllGlobals();await rm(root,{recursive:true,force:true});});
async function start(warm=true){const constructed=deferred<InstanceType<typeof ws.Socket>>();ws.state.constructed=s=>constructed.resolve(s);const pending=view.ensureVoiceStandby(),socket=await Promise.race([constructed.promise,Promise.resolve(pending).then(()=>{throw Error('Original startup ended before a socket was constructed: '+view.agentReply);})]);socket.emit('open');await pending;
 const client=view.agentRealtimeClient;await vi.waitFor(()=>expect(Boolean(client.initialInstructions?.slot)).toBe(false));if(warm){await vi.advanceTimersByTimeAsync(3000);expect(view.agentVoiceRuntime.snapshot().sessionPhase).toBe('listening');}return{client,socket};}
async function bounded<T>(p:Promise<T>,label:string,client:any):Promise<T>{let timer:ReturnType<typeof wallTimer>;try{return await Promise.race([p,new Promise<never>((_,reject)=>{timer=wallTimer(()=>reject(Error(label+' did not finish: '+JSON.stringify({reply:view.agentReply,pending:client.responseRequestPending,preparing:client.responsePreparationPending,queued:client.queuedResponseCreate,closed:client.intentionalClose}))),2000);})]);}finally{clearWallTimer(timer!);}}
async function request(client:any,socket:InstanceType<typeof ws.Socket>,text='你好，晚上好'){const sent=deferred<void>();ws.state.sent=(s,p)=>{if(s===socket&&p.type==='response.create')sent.resolve();};const n=socket.sent.filter(p=>p.type==='response.create').length;socket.message({type:'conversation.item.input_audio_transcription.completed',item_id:'input-'+n,transcript:text});await bounded(sent.promise,'original ASR to response send '+text,client);ws.state.sent=undefined;}
async function reply(socket:InstanceType<typeof ws.Socket>,client:any,id:string,used:any=usage,type='response.done',replyText='纯虚构完成'){
 const completed=deferred<void>(),runtime=view.agentVoiceRuntime,turnId=runtime.snapshot().currentTurn?.turnId;
 const originalSetBusy=view.setAgentBusy.bind(view);
 const busy=vi.spyOn(view,'setAgentBusy').mockImplementation((...args:unknown[])=>{
  originalSetBusy(...args);
  const current=runtime.snapshot().currentTurn;
  if(args[0]===false&&view.agentVoiceRuntime===runtime&&current?.turnId===turnId&&current.phase==='completed')completed.resolve();
 });
 let deadline:ReturnType<typeof wallTimer>|undefined;
 try{
  socket.message({type:'response.created',response:{id}});
  socket.message({type:'response.text.delta',response_id:id,delta:replyText});
  socket.message({type,response:{id,status:'completed',usage:used}});
  // Completion includes asynchronous source validation and disk persistence.
  // Observe the owned runtime transition rather than polling/fake-clock advance.
  await Promise.race([completed.promise,new Promise<never>((_,reject)=>{
   deadline=wallTimer(()=>reject(Error('Fresh owned reply did not complete within15s: '+JSON.stringify({busy:view.agentBusy,phase:runtime.snapshot().currentTurn?.phase,activeResponse:Boolean(client.activeResponseId)}))),15000);
  })]);
  expect(Boolean(client.activeResponseId)).toBe(false);
  expect(view.agentBusy).toBe(false);
 }finally{if(deadline!==undefined)clearWallTimer(deadline);busy.mockRestore();}
}
const sameText='你好，海豚第1次问候。';
it('does not submit the previous utterance on a replacement connection after pending action inspection finishes',async()=>{
 const first=await start(),held=deferred<boolean>();
 const inspect=vi.spyOn(view,'tryAcceptPendingActionFromVoice').mockImplementationOnce(()=>held.promise);
 first.socket.message({type:'conversation.item.input_audio_transcription.completed',item_id:'retired-utterance',transcript:'你好，海豚晚上好。'});
 await vi.waitFor(()=>expect(inspect).toHaveBeenCalledOnce());
 view.stopVoiceStandby();view.agentMode='text';view.agentMode='voice';const second=await start();
 const history=view.agentMessages.slice();held.resolve(false);await Promise.resolve();await Promise.resolve();
 expect(second.socket.sent.filter(p=>p.type==='response.create')).toHaveLength(0);
 expect(view.agentMessages).toEqual(history);expect(view.agentBusy).toBe(false);
 expect(view.agentVoiceRuntime.snapshot().sessionPhase).toBe('listening');
 await request(second.client,second.socket,'你好，这是新会话的问题。');await reply(second.socket,second.client,'fresh-after-retired-inspection');
 expect(view.agentMessages.filter((m:any)=>m.role==='user').map((m:any)=>m.content)).toEqual(['你好，这是新会话的问题。']);
 expect(view.agentBusy).toBe(false);expect(fetchGuard).not.toHaveBeenCalled();
},20000);
it('a delayed manual stop cannot close or clear the replacement voice session after switching through text',async()=>{
 Object.assign(plugin.settings.ai,{provider:'qwen',apiKey:'synthetic-only',model:'qwen3.8-flash',dataDisclosureAccepted:true});
 plugin.settings.realtimeVoice.mode='cascade';const first=await start();
 const stopped=view.stopBailianRealtimeRecording(false);
 view.stopVoiceStandby();view.agentMode='text';view.agentMode='voice';
 const second=await start(false),track=tracks.at(-1),context=contexts.at(-1),replyBefore=view.agentReply;
 expect(second.client).not.toBe(first.client);expect(first.socket.readyState).toBe(3);
 await vi.advanceTimersByTimeAsync(260);await stopped;
 expect(view.agentRealtimeClient).toBe(second.client);expect(second.socket.readyState).toBe(1);
 expect(view.agentRecording).toBe(true);expect(track.readyState).toBe('live');expect(context.state).toBe('running');
 expect(view.agentReply).toBe(replyBefore);
 await vi.advanceTimersByTimeAsync(3000);expect(view.agentVoiceReady).toBe(true);
 expect(view.agentVoiceRuntime.snapshot().sessionPhase).toBe('listening');expect(fetchGuard).not.toHaveBeenCalled();
},20000);
it('keeps tentative ASR text in the composer on a manual stop without sending it', async () => {
  Object.assign(plugin.settings.ai, { provider: 'qwen', apiKey: 'synthetic-only', model: 'qwen3.8-flash', dataDisclosureAccepted: true });
  plugin.settings.realtimeVoice.mode = 'cascade';
  plugin.settings.realtimeVoice.autoSendOnStop = true;
  await start();
  const draft = '明天三点虚构样本';
  view.updateRealtimeTranscript(draft, false, false, true);
  expect(view.agentInput).toBe(draft);
  const stopped = view.stopBailianRealtimeRecording(false);
  await vi.advanceTimersByTimeAsync(260);
  await stopped;
  expect(view.agentInput).toBe(draft);
  expect(view.agentReply).toContain('未完成的听写留在输入框');
  expect(view.agentMessages).toHaveLength(0);
  expect(fetchGuard).not.toHaveBeenCalled();
}, 20000);
it('a manual stop that resumes after rendering cannot stop a newer voice runtime',async()=>{
 Object.assign(plugin.settings.ai,{provider:'qwen',apiKey:'synthetic-only',model:'qwen3.8-flash',dataDisclosureAccepted:true});
 plugin.settings.realtimeVoice.mode='cascade';await start();
 const rendering=deferred<void>(),release=deferred<void>(),render=view.render;
 view.render=vi.fn(async()=>{rendering.resolve();await release.promise;});
 const stopped=view.stopBailianRealtimeRecording(false);await vi.advanceTimersByTimeAsync(260);await rendering.promise;
 view.render=render;view.agentMode='text';view.agentMode='voice';const second=await start();
 release.resolve();await stopped;
 expect(view.agentRealtimeClient).toBe(second.client);expect(second.socket.readyState).toBe(1);
 expect(view.agentVoiceRuntime.snapshot().sessionPhase).toBe('listening');expect(view.agentVoiceReady).toBe(true);
 expect(tracks.at(-1).readyState).toBe('live');expect(contexts.at(-1).state).toBe('running');expect(fetchGuard).not.toHaveBeenCalled();
},20000);
it('current-session sent and replaced assistant fragments stay filtered while old message objects and list trimming do not define the boundary',async()=>{
 const oldUser={role:'user',content:'请回顾昨日青色森林的记录。'},oldAssistant={role:'assistant',content:'昨日青色森林记录已保存。'};view.agentMessages=[oldUser,oldAssistant];const first=await start();expect(view.normalizeRealtimeTranscript(oldUser.content)).toBe(oldUser.content);
 const currentText='请介绍琥珀湖岸的灯塔。',assistant='琥珀湖岸边的灯塔正在等待晚风。';await request(first.client,first.socket,currentText);await reply(first.socket,first.client,'current-session',undefined,'response.done',assistant);expect(view.normalizeRealtimeTranscript(currentText)).toBe('');expect(view.normalizeRealtimeTranscript(assistant)).toBe('');
 const currentAssistant=view.agentMessages.find((m:any)=>m.role==='assistant'&&m.content===assistant);expect(currentAssistant).toBeDefined();const replacement={...currentAssistant,content:'琥珀湖岸边的灯塔还在等待月亮。'};view.agentMessages=view.agentMessages.map((m:any)=>m===currentAssistant?replacement:m);expect(view.normalizeRealtimeTranscript(replacement.content)).toBe('');
 view.agentMessages=[...view.agentMessages,...Array.from({length:12},(_,i)=>({role:'assistant',content:'这是用于滚动列表的虚构占位内容第'+i+'段。'}))].slice(-12);expect(view.agentMessages.includes(oldUser)).toBe(false);const newest={role:'assistant',content:'新会话里的银色帆船正在缓缓靠岸。'};view.agentMessages=[...view.agentMessages,newest].slice(-12);expect(view.normalizeRealtimeTranscript(newest.content)).toBe('');expect(view.normalizeRealtimeTranscript(oldUser.content)).toBe(oldUser.content);
 expect(fetchGuard).not.toHaveBeenCalled();
},20000);
