import { afterEach, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DeviceExecution } from "../src/features/devices/execution";
import { localDeviceStorage } from "../src/features/devices/localStorage";
afterEach(()=>vi.unstubAllGlobals());
it("keeps a device identity in application storage across reopen without writing plugin settings",()=>{
 const values=new Map<string,unknown>();const app={loadLocalStorage:(key:string)=>values.get(key),saveLocalStorage:(key:string,value:unknown)=>values.set(key,value)} as unknown as App;
 const a=new DeviceExecution(localDeviceStorage(app),async()=>null);
 const reopened=new DeviceExecution(localDeviceStorage(app),async()=>null);
 expect(reopened.deviceId).toBe(a.deviceId);expect(reopened.needsSetup).toBe(true);
});
it("supports older Obsidian storage and separates different vaults in the same application profile",()=>{
 const values=new Map<string,string>();vi.stubGlobal("localStorage",{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)});
 const app=(name:string)=>({vault:{adapter:{getBasePath:()=>"/fictional/"+name},getName:()=>name}} as unknown as App);
 const a=new DeviceExecution(localDeviceStorage(app("first")),async()=>null);
 const b=new DeviceExecution(localDeviceStorage(app("second")),async()=>null);
 const reopened=new DeviceExecution(localDeviceStorage(app("first")),async()=>null);
 expect(a.deviceId).not.toBe(b.deviceId);expect(reopened.deviceId).toBe(a.deviceId);
});
