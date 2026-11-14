import {mkdtemp,rm} from 'node:fs/promises';
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
async function start(){const constructed=deferred<InstanceType<typeof ws.Socket>>();ws.state.constructed=s=>constructed.resolve(s);const pending=view.ensureVoiceStandby(),socket=await Promise.race([constructed.promise,Promise.resolve(pending).then(()=>{throw Error('Original startup ended before a socket was constructed: '+view.agentReply);})]);socket.emit('open');await pending;
 const client=view.agentRealtimeClient;await vi.waitFor(()=>expect(Boolean(client.initialInstructions?.slot)).toBe(false));await vi.advanceTimersByTimeAsync(3000);expect(view.agentVoiceRuntime.snapshot().sessionPhase).toBe('listening');return{client,socket};}
async function bounded<T>(p:Promise<T>,label:string,client:any):Promise<T>{let timer:ReturnType<typeof wallTimer>;try{return await Promise.race([p,new Promise<never>((_,reject)=>{timer=wallTimer(()=>reject(Error(label+' did not finish: '+JSON.stringify({reply:view.agentReply,pending:client.responseRequestPending,preparing:client.responsePreparationPending,queued:client.queuedResponseCreate,closed:client.intentionalClose}))),2000);})]);}finally{clearWallTimer(timer!);}}
async function request(client:any,socket:InstanceType<typeof ws.Socket>,text='你好，晚上好'){const sent=deferred<void>();ws.state.sent=(s,p)=>{if(s===socket&&p.type==='response.create')sent.resolve();};const n=socket.sent.filter(p=>p.type==='response.create').length;socket.message({type:'conversation.item.input_audio_transcription.completed',item_id:'input-'+n,transcript:text});await bounded(sent.promise,'original ASR to response send '+text,client);ws.state.sent=undefined;}
async function reply(socket:InstanceType<typeof ws.Socket>,client:any,id:string,used:any=usage,type='response.done'){
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
  socket.message({type:'response.text.delta',response_id:id,delta:'纯虚构完成'});
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

it.each([false,true])('original View releases ambiguous old connection, keeps repeat notice visible, and recovers without automatic resend (queued=%s)',async queued=>{
 const{client,socket}=await start();const append=vi.spyOn(plugin,'appendAgentConversation');const bubble=vi.spyOn(view,'appendAgentMessage');await request(client,socket);
 socket.message({type:'input_audio_buffer.speech_started',item_id:'interrupt'});
 socket.message({type:'conversation.item.input_audio_transcription.delta',item_id:'interrupt',delta:'等一下'});
 await vi.waitFor(()=>expect(client.responseCancelPending).toBe(true));
 if(queued){socket.message({type:'conversation.item.input_audio_transcription.completed',item_id:'next-before-cancel-ack',transcript:'请回答另一个虚构问题'});await vi.waitFor(()=>expect(client.queuedResponseCreate).toBe(true));}
 await vi.advanceTimersByTimeAsync(2000);
 expect(socket.readyState).toBe(3);expect(socket.sent.filter(p=>p.type==='response.create')).toHaveLength(1);
 expect(view.agentBusy).toBe(false);expect(view.agentVoiceSendInFlight).toBe(false);expect(view.agentSpeaking).toBe(false);expect(view.agentRealtimeClient).toBeNull();expect(view.agentStream).toBeNull();expect(tracks.every(t=>t.readyState==='ended')).toBe(true);expect(contexts.every(c=>c.state==='closed')).toBe(true);expect(view.agentVoiceReconnectTimer).not.toBe(0);
 expect(view.agentMessages.filter((m:any)=>m.role==='assistant'&&m.content.includes('重新连接后请重说'))).toHaveLength(1);
 if(!queued)expect(bubble).toHaveBeenCalledWith(expect.objectContaining({role:'assistant',content:expect.stringContaining('请重说')}));
 socket.message({type:'response.created',response:{id:'late-old'}});socket.message({type:'response.text.delta',response_id:'late-old',delta:'OLD_CANCELLED'});socket.message({type:'response.audio.delta',response_id:'late-old',delta:'AQACAA=='});socket.message({type:'response.done',response:{id:'late-old',status:'completed'}});
 expect(view.agentMessages.some((m:any)=>m.content.includes('OLD_CANCELLED'))).toBe(false);expect(append).not.toHaveBeenCalled();
 const constructed=deferred<InstanceType<typeof ws.Socket>>();ws.state.constructed=s=>constructed.resolve(s);await vi.advanceTimersByTimeAsync(1000);const next=await bounded(constructed.promise,'original bounded reconnect',client);next.emit('open');await vi.waitFor(()=>expect(view.agentAudioContext).not.toBeNull());await vi.advanceTimersByTimeAsync(3000);
 expect(view.agentVoiceRuntime.snapshot().sessionPhase).toBe('listening');expect(next.sent.filter(p=>p.type==='response.create')).toHaveLength(0);expect(view.agentMessages.some((m:any)=>m.content.includes('重新连接后请重说'))).toBe(true);
 if(queued)expect(view.normalizeRealtimeTranscript('你好，晚上好')).toBe('');
 await request(view.agentRealtimeClient,next,queued?'请回答另一个虚构问题':'你好，晚上好');await reply(next,view.agentRealtimeClient,'fresh-owned');expect(append).toHaveBeenCalledOnce();expect(view.agentBusy).toBe(false);expect(view.agentVoiceRuntime.snapshot().currentTurn.phase).toBe('completed');expect(fetchGuard).not.toHaveBeenCalled();
 expect(view.normalizeRealtimeTranscript(queued?'请回答另一个虚构问题':'你好，晚上好')).toBe('');
},20000);
