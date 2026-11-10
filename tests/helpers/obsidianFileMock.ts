// Obsidian file API surface used only by a bundled, offline child-process test.
export class App {}
export class Notice {}
export class TFile {}
export class TFolder {}
export const normalizePath = (path: string): string => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
export const requestUrl = (): never => { throw new Error("Provider calls are forbidden in file recovery tests"); };
export const parseYaml = (): never => { throw new Error("This recovery fixture does not read YAML properties"); };
export const stringifyYaml = (): never => { throw new Error("This recovery fixture does not write YAML properties"); };
