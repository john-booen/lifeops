/** One pending macrotask owned by an output flight, never a source-validity proof. */
export function createOutputSliceYield(){
 let disposed=false,pending:{cancel:(retired:boolean)=>void}|undefined;
 const cancel=()=>pending?.cancel(false);
 return {cancel,dispose(){disposed=true;pending?.cancel(true);},wait():Promise<void>{
  if(disposed)return Promise.reject(Error("语音输出分片已经结束。"));
  if(pending)return Promise.reject(Error("语音输出分片尚未结束。"));
  const host=globalThis,schedule=host.setTimeout,clear=host.clearTimeout;
  return new Promise<void>((resolve,reject)=>{
   let timer:ReturnType<typeof setTimeout>|undefined,active=false,fired=false,settled=false,arming=true;
   let deferred:{failed:boolean;error:unknown}|undefined;
   const finish=(failed:boolean,error?:unknown)=>{
    if(settled)return;
    if(arming){deferred??={failed,error};return;}
    settled=true;if(pending===owned)pending=undefined;
    if(active){active=false;const handle=timer;timer=undefined;try{Reflect.apply(clear,host,[handle]);}catch(clearError){failed=true;error=clearError;}}
    if(failed)reject(error);else resolve();
   };
   const owned={cancel:(retired:boolean)=>finish(retired,retired?Error("语音输出分片已经结束。"):undefined)};pending=owned;
   try{
    const handle=Reflect.apply(schedule,host,[()=>{
     if(settled)return;fired=true;active=false;timer=undefined;
     finish(arming||disposed,arming?Error("语音输出分片未异步调度。"):disposed?Error("语音输出分片已经结束。"):undefined);
    },0]);
    if(!fired){timer=handle;active=true;}
    arming=false;if(deferred)finish(deferred.failed,deferred.error);
   }catch(error){arming=false;finish(true,error);}
  });
 }};
}

/** Scheduling only: a single publication/callback can exceed this cooperative budget. */
export function createOutputSliceBudget(){
 let read:(()=>number)|undefined,unknown=false;
 try{const host=globalThis.performance,now=host?.now;if(typeof now==='function')read=()=>Reflect.apply(now,host,[]);}catch{}
 const sample=()=>{try{const value=read?.();return typeof value==='number'&&Number.isFinite(value)?value:undefined;}catch{return undefined;}};
 return ()=>{
  const start=unknown?undefined:sample();if(start===undefined)unknown=true;
  let previous=start,count=0;
  return ()=>{
   count++;
   if(unknown)return count>=2;
   const now=sample();
   // An anomaly ends this slice immediately; only later slices can promise max2.
   if(now===undefined||previous===undefined||now<=previous){unknown=true;return true;}
   previous=now;return count>=32||now-start!>=8;
  };
 };
}
