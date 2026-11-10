import{beforeEach,afterEach,afterAll,it,expect,vi}from'vitest';
import{mkdir,mkdtemp,writeFile,rm}from'node:fs/promises';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{randomUUID}from'node:crypto';
import{DEFAULT_SETTINGS}from'../src/defaults';
import{BailianRealtimeClient}from'../src/bailianRealtime';
const ws=vi.hoisted(()=>{const sockets:any[]=[];class Socket{static OPEN=1;readyState=0;sent:any[]=[];handlers=new Map<string,Function[]>();constructor(){sockets.push(this);}on(n:string,f:Function){this.handlers.set(n,[...(this.handlers.get(n)??[]),f]);return this;}emit(n:string,...args:any[]){if(n==='open')this.readyState=1;if(n==='close')this.readyState=3;for(const f of this.handlers.get(n)??[])f(...args);}message(x:any){this.emit('message',JSON.stringify(x));}send(x:string){this.sent.push(JSON.parse(x));}close(){this.emit('close',1000,Buffer.alloc(0));}terminate(){this.readyState=3;}}return{Socket,sockets};});
vi.mock('ws',()=>({default:ws.Socket}));
vi.mock('obsidian',()=>({App:class{},Plugin:class{},TFile:class{},TFolder:class{},WorkspaceLeaf:class{},ItemView:class{},Modal:class{},PluginSettingTab:class{},Setting:class{},Platform:{isDesktopApp:true},Notice:class{},normalizePath:(p:string)=>p.replace(/\\/g,'/').replace(/\/{2,}/g,'/'),setIcon:vi.fn(),requestUrl:()=>{throw Error('Offline only');}}));
const{LifeOpsStore}=await import('../src/store'),{DiskVault}=await import('./helpers/diskVault'),{default:Plugin}=await import('../src/main'),{buildOmniE2eInstructions}=await import('../src/voice/voiceRealtime');
const phase=process.env.LIFEOPS_PLAYBACK_KIND??'playback-original',reports:any[]=[];let ordinal=0,vault:any,store:any,plugin:any,note:string,client:any,socket:any,delayMs=0,readCount=0,trace:any[],delivered:any[],ctxErrors:string[],run:any;
const sleep=(ms:number)=>new Promise<void>(yes=>setTimeout(yes,ms)),until=async(p:()=>boolean,ms=6000)=>{const end=Date.now()+ms;while(!p()){if(Date.now()>=end)throw Error('local bounded observation deadline');await sleep(2);}};
const sent=(type:string)=>socket.sent.filter((x:any)=>x.type===type),sample=()=>({at:Date.now(),pending:client?.toolEventPending??0,bytes:client?.toolEventBytes??0,reads:readCount,state:socket?.readyState??null,delivered:delivered.length});
beforeEach(async()=>{vi.stubGlobal('window',globalThis);ws.sockets.length=0;delayMs=0;readCount=0;trace=[];delivered=[];ctxErrors=[];client=null;socket=null;ordinal++;const root=await mkdtemp(join(tmpdir(),'lifeops-playback-batch-'));vault=new DiskVault(root);const app:any={vault,workspace:{getLeavesOfType:()=>[]}};store=new LifeOpsStore(app,structuredClone(DEFAULT_SETTINGS));await store.initializeVault();const today=new Date(),date=[today.getFullYear(),String(today.getMonth()+1).padStart(2,'0'),String(today.getDate()).padStart(2,'0')].join('-');note=store.path(store.settings.folders.aiReports,'Conversations',date+'.md');await vault.seed(note,'纯虚构稳定来源：蓝鲸在左边。');plugin=Object.assign(Object.create(Plugin.prototype),{app,store,settings:store.settings,lifecycleGeneration:1,unloaded:false,updateStatusBar:async()=>{},refreshViews:async()=>{},lifeOpsEvents:{publish:()=>{}}});const originalRead=vault.read.bind(vault);vi.spyOn(vault,'read').mockImplementation(async(file:any)=>{readCount++;if(delayMs)await sleep(delayMs);return originalRead(file);});run={phase,case:ordinal,actualMainSnapshot:true,actualStoreAndPhysicalSourceRead:true};});
afterEach(async()=>{run.final=sample();run.contextErrors=[...ctxErrors];run.delivered=delivered;run.samples=trace;reports.push(run);if(host?.agentVoiceResponseTimer)clearTimeout(host.agentVoiceResponseTimer);client?.close();await sleep(30);vi.restoreAllMocks();vi.unstubAllGlobals();await rm(vault.root,{recursive:true,force:true});});
afterAll(async()=>{if(process.env.LIFEOPS_THROUGHPUT_REPORT)await writeFile(process.env.LIFEOPS_THROUGHPUT_REPORT,JSON.stringify({at:new Date().toISOString(),reports,App:0,Provider:0,Key:0,physicalMedia:0,ubRootCauseProved:false},null,2)+'\n',{flag:'wx',mode:384});});
async function open(){
 const settings={...store.settings.realtimeVoice,mode:'omni-e2e',apiKey:'synthetic-only',dataDisclosureAccepted:true,plaintextCredentialStorageAccepted:true};
 client=new BailianRealtimeClient(settings,{onToolContextError:(error:string)=>ctxErrors.push(error)},{mode:'omni-e2e'});
 const pending=client.connect();socket=ws.sockets.at(-1);socket.emit('open');await pending;
}

const {VoiceSessionController}=await import('../src/voice/voiceRuntime');
const {handleOmniE2eAudioDelta,handleOmniE2eAudioDone}=await import('../src/voice/voiceRealtime');
let host:any,output:any,checks=0,validationHook:(()=>Promise<void>)|undefined;
function hostView(){const runtime=new VoiceSessionController();runtime.connect();runtime.connected();runtime.beginTurn({route:'e2e',transcript:'纯虚构播放来源核对。'});runtime.transitionTurn('routing','fixture');runtime.transitionTurn('generating','fixture');runtime.bindResponse('fixture-response');output={start:vi.fn(async()=>{}),appendPcm16:vi.fn(()=>true),finish:vi.fn(()=>true),fail:vi.fn(),cancel:vi.fn()};host={viewClosed:false,agentTextRequestGeneration:1,agentVoicePipelineGeneration:1,agentVoiceRuntime:runtime,controller:plugin,pendingAgentActions:[],agentOmniE2eReply:'',agentReply:'',agentOmniE2eAssistantIndex:-1,agentMessages:[],agentVoiceTrace:{},agentOmniPendingAudio:[],agentOmniPlaybackReady:null,agentAudioOutput:output,agentRealtimeClient:client,agentMode:'voice',refreshAgentSuggestions:vi.fn(),refreshAgentSurfaceState:vi.fn(),markVoiceTrace:vi.fn(),setAgentBusy:vi.fn()};return host;}
async function openedPlayback(){store.settings.realtimeVoice={...store.settings.realtimeVoice,mode:'omni-e2e',speakReplies:true};await open();hostView();checks=0;validationHook=undefined;const original=client.assertContextSourcesCurrent.bind(client);vi.spyOn(client,'assertContextSourcesCurrent').mockImplementation(async()=>{checks++;await original();if(validationHook)await validationHook();});}
function pcm(i:number){return Buffer.from(new Int16Array([i,0]).buffer).toString('base64');}
function audio(i:number){handleOmniE2eAudioDelta(host,pcm(i),24000,{eventType:'response.audio.delta',responseId:'fixture-response',status:'in_progress'});}
it('drains an audio burst in order without rereading context',async()=>{await openedPlayback();run.label='realView32audio-startPending-emptyFlush';let release!:()=>void;const gate=new Promise<void>(yes=>release=yes);output.start.mockImplementation(()=>gate);for(let i=0;i<32;i++)audio(i);release();await until(()=>output.appendPcm16.mock.calls.length===32);await sleep(100);run.playbackChecks=checks;run.physicalStreamReads=readCount-run.readsBeforeStream;run.appended=output.appendPcm16.mock.calls.map((x:any[])=>x[1][0]);expect(run.appended).toEqual(Array.from({length:32},(_,i)=>i));expect(checks).toBe(0);const settledChecks=checks;await sleep(30);expect(checks).toBe(settledChecks);expect(ctxErrors).toEqual([]);});
function holdRead(ordinal=1){const previous=validationHook;let release!:()=>void,enter!:()=>void,count=0;const entered=new Promise<void>(yes=>enter=yes),gate=new Promise<void>(yes=>release=yes);validationHook=async()=>{if(previous)await previous();if(++count===ordinal){enter();await gate;}};return{entered,release};}
function freezeNoteMetadata(){const stat=structuredClone(vault.getFileByPath(note).stat),get=vault.getAbstractFileByPath.bind(vault);vi.spyOn(vault,'getAbstractFileByPath').mockImplementation((...args:unknown[])=>{const f=get(args[0] as string);if(f?.path===note)f.stat={...stat};return f;});}
it('enqueue refusal ends the drain without finishing failed output',async()=>{await openedPlayback();run.label='playback-enqueue-refused';output.appendPcm16.mockReturnValue(false);audio(1);handleOmniE2eAudioDone(host,{eventType:'response.audio.done',responseId:'fixture-response',status:'in_progress'});await until(()=>output.fail.mock.calls.length===1);await sleep(30);expect(output.finish).not.toHaveBeenCalled();expect(output.fail).toHaveBeenCalledOnce();});

it('late PCM after terminal is rejected without retaining chunks or revalidating empty output',async()=>{await openedPlayback();run.label='late-audio-after-terminal';audio(1);await until(()=>output.appendPcm16.mock.calls.length===1);handleOmniE2eAudioDone(host,{eventType:'response.audio.done',responseId:'fixture-response',status:'in_progress'});await until(()=>output.finish.mock.calls.length===1);const terminalChecks=checks;const ownedQueue=host.agentOmniPendingAudio;output.fail.mockImplementation(()=>{host.agentOmniPendingAudio=[{pcm:new Int16Array([99]),sampleRate:24000}];});audio(2);expect(ownedQueue).toHaveLength(0);expect(host.agentOmniPendingAudio[0].pcm[0]).toBe(99);expect(output.appendPcm16).toHaveBeenCalledOnce();expect(output.fail).toHaveBeenCalledOnce();expect(output.finish).toHaveBeenCalledOnce();expect(checks).toBe(terminalChecks);});

it('work-budget slices allow a timer before the third append, with no empty revalidation',async()=>{
 await openedPlayback();let observed=-1,budgetNow=0;vi.spyOn(performance,'now').mockImplementation(()=>budgetNow+=0.01);
 output.appendPcm16.mockImplementation(()=>{budgetNow+=4;if(output.appendPcm16.mock.calls.length===2)setTimeout(()=>{observed=output.appendPcm16.mock.calls.length;},0);return true;});
 for(let i=0;i<8;i++)audio(i);await until(()=>output.appendPcm16.mock.calls.length===8);await until(()=>observed>=0);
 expect(observed).toBe(2);expect(output.appendPcm16.mock.calls.map((x:any[])=>x[1][0])).toEqual([0,1,2,3,4,5,6,7]);const finishedChecks=checks;await sleep(30);expect(checks).toBe(finishedChecks);expect(output.finish).not.toHaveBeenCalled();
});
it('a cancelled output event immediately clears the suspended slice timer',async()=>{
 await openedPlayback();let budgetNow=0;vi.spyOn(performance,'now').mockImplementation(()=>budgetNow+=0.01);const original=globalThis.setTimeout,clear=vi.spyOn(globalThis,'clearTimeout');let lastZero:ReturnType<typeof setTimeout>|undefined,cleared=false;
 vi.spyOn(globalThis,'setTimeout').mockImplementation(((fn:()=>void,delay?:number)=>{const h=Reflect.apply(original,globalThis,[fn,delay]);if(delay===0)lastZero=h;return h;})as typeof setTimeout);
 const{handleOmniE2eAudioOutputEvent}=await import('../src/voice/voiceRealtime');
 output.appendPcm16.mockImplementation(()=>{budgetNow+=4;if(output.appendPcm16.mock.calls.length===2)setTimeout(()=>{const owned=lastZero;const playbackId=host.agentVoiceRuntime.snapshot().currentTurn.playbackId;handleOmniE2eAudioOutputEvent(host,{type:'cancelled',playbackId,owner:'native-e2e',timestamp:Date.now()});cleared=clear.mock.calls.some(([h])=>h===owned);},0);return true;});
 for(let i=0;i<8;i++)audio(i);await until(()=>cleared);await sleep(30);expect(cleared).toBe(true);expect(output.appendPcm16.mock.calls).toHaveLength(2);expect(output.finish).not.toHaveBeenCalled();
});

it.each(['nonfinite','frozen'] as const)('an unknown %s scheduling clock still lets a timer precede later PCM',async kind=>{
 await openedPlayback();vi.spyOn(performance,'now').mockImplementation(()=>kind==='nonfinite'?NaN:1);let observed=-1;
 output.appendPcm16.mockImplementation(()=>{if(output.appendPcm16.mock.calls.length===1)setTimeout(()=>{observed=output.appendPcm16.mock.calls.length;},0);return true;});
 for(let i=0;i<8;i++)audio(i);await until(()=>output.appendPcm16.mock.calls.length===8);await until(()=>observed>=0);expect(observed).toBeGreaterThan(0);expect(observed).toBeLessThanOrEqual(2);expect(ctxErrors).toEqual([]);
});
it('a clock regression ends the current prefix immediately, without relabeling it max2',async()=>{
 await openedPlayback();let now=0,observed=-1;vi.spyOn(performance,'now').mockImplementation(()=>now+=0.01);
 output.appendPcm16.mockImplementation(()=>{if(output.appendPcm16.mock.calls.length===5){now=-100;setTimeout(()=>{observed=output.appendPcm16.mock.calls.length;},0);}return true;});
 for(let i=0;i<8;i++)audio(i);await until(()=>output.appendPcm16.mock.calls.length===8);await until(()=>observed>=0);expect(observed).toBe(5);expect(ctxErrors).toEqual([]);
});
