import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => ({
  Plugin: class { constructor(readonly app: unknown, readonly manifest: unknown) {} },
  Notice: class {}, Modal: class {}, TFile: class {}, TFolder: class {},
  ItemView: class {}, PluginSettingTab: class {}, Setting: class {},
  Platform: { isDesktopApp: false }, normalizePath: (path: string) => path,
  requestUrl: vi.fn(() => { throw new Error('Unexpected provider request'); }), setIcon: vi.fn()
}));
vi.mock('../src/lifeOpsView', () => ({ LIFEOPS_VIEW_TYPE: 'lifeops', LifeOpsView: class {} }));
vi.mock('../src/settingsTab', () => ({ LifeOpsSettingTab: class {} }));
vi.mock('../src/journalPresentation', () => ({ refreshJournalPresentation: vi.fn(), clearJournalPresentation: vi.fn() }));

const { default: LifeOpsPlugin } = await import('../src/main');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
let plugin: any;
let store: any;
beforeEach(() => {
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network'); }));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(() => { throw new Error('Unexpected device'); }) } });
  const app = { workspace: { getLeavesOfType: vi.fn(() => []), detachLeavesOfType: vi.fn() }, vault: { adapter: { read: vi.fn(async () => '') }, getAbstractFileByPath: vi.fn(() => null) }, metadataCache: { on: vi.fn() } };
  plugin = new LifeOpsPlugin(app as never, { id: 'lifeops-assistant', dir: '' } as never);
  store = {
    settings: plugin.settings,
    initializeVault: vi.fn(async () => {}), syncVaultSources: vi.fn(async () => {}),
    buildSituationContext: vi.fn(async () => 'synthetic-only'), searchKnowledge: vi.fn(async () => [])
  };
  Object.assign(plugin, {
    store, platformCapabilities: { limitations: [] },
    registerVaultSourceEvents: vi.fn(), updateStatusBar: vi.fn(async () => {})
  });
});
afterEach(async () => {
  plugin.onunload();
  vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

it('keeps a native tab group alive when reopening LifeOps from its only main leaf', async () => {
  let oldLeaves = 1, tabLeaves = 1;
  const replacement = { setViewState: vi.fn(async () => {}) };
  plugin.app.workspace.getLeaf = vi.fn(() => {
    if (!tabLeaves) throw new Error('No tab group found');
    tabLeaves++; return replacement;
  });
  plugin.app.workspace.detachLeavesOfType.mockImplementation(() => { tabLeaves -= oldLeaves; oldLeaves = 0; });
  await plugin.activateView(true);
  expect(tabLeaves).toBe(1); expect(replacement.setViewState).toHaveBeenCalledWith({ type: 'lifeops', active: true });
});

describe('actual plugin bootstrap helper cancellation (mock host, no native app claim)', () => {
  it('does not register Vault listeners after unload during initializeVault', async () => {
    const waiting = deferred(), entered = deferred();
    store.initializeVault.mockImplementation(async () => { entered.resolve(); await waiting.promise; });
    const bootstrap = plugin.bootstrapDataFoundation();
    await entered.promise; plugin.onunload(); waiting.resolve(); await bootstrap;
    expect({
      listenerRegistrations: plugin.registerVaultSourceEvents.mock.calls.length,
      syncCalls: store.syncVaultSources.mock.calls.length,
      statusRefreshes: plugin.updateStatusBar.mock.calls.length
    }).toEqual({ listenerRegistrations: 0, syncCalls: 0, statusRefreshes: 0 });
  });
  it('does not refresh after unload during syncVaultSources', async () => {
    const waiting = deferred(), entered = deferred();
    store.syncVaultSources.mockImplementation(async () => { entered.resolve(); await waiting.promise; });
    const bootstrap = plugin.bootstrapDataFoundation();
    await entered.promise; plugin.onunload(); waiting.resolve(); await bootstrap;
    expect(plugin.updateStatusBar).not.toHaveBeenCalled();
  });
  it('coalesces overlapping bootstrap calls', async () => {
    const waiting = deferred(), entered = deferred();
    store.initializeVault.mockImplementation(async () => { entered.resolve(); await waiting.promise; });
    const first = plugin.bootstrapDataFoundation(); await entered.promise;
    const second = plugin.bootstrapDataFoundation();
    waiting.resolve(); await Promise.all([first, second]);
    expect(store.initializeVault).toHaveBeenCalledTimes(1);
    expect(store.syncVaultSources).toHaveBeenCalledTimes(1);
  });
  it('does not begin initialization once the plugin has unloaded', async () => {
    plugin.onunload(); await plugin.bootstrapDataFoundation();
    expect(store.initializeVault).not.toHaveBeenCalled();
  });
});

function loadHost() {
  vi.useFakeTimers();
  const layouts: Array<() => void> = [];
  Object.assign(plugin.app.workspace, { on: vi.fn(), onLayoutReady: (callback: () => void) => layouts.push(callback) });
  Object.assign(plugin, {
    loadSettings: vi.fn(async () => {}), hardenPluginDataPermissions: vi.fn(async () => {}), injectStyles: vi.fn(async () => {}),
    register: vi.fn(), registerEvent: vi.fn(), registerView: vi.fn(), addRibbonIcon: vi.fn(), addCommand: vi.fn(), addSettingTab: vi.fn(),
    addStatusBarItem: vi.fn(() => ({ setText: vi.fn(), toggleClass: vi.fn() })), registerInterval: vi.fn()
  });
  return layouts;
}

describe('production lifecycle continuations after unload', () => {
  it('does not start saving settings on an already unloaded instance', async () => {
    plugin.saveData = vi.fn(async () => {});
    plugin.hardenPluginDataPermissions = vi.fn(async () => {});
    plugin.onunload(); await plugin.saveSettings();
    expect(plugin.saveData).not.toHaveBeenCalled();
    expect(plugin.hardenPluginDataPermissions).not.toHaveBeenCalled();
    expect(plugin.store).toBe(store);
  });
  it('does not rebuild runtime after an old settings save settles following unload', async () => {
    const waiting = deferred(), entered = deferred();
    plugin.saveData = vi.fn(async () => { entered.resolve(); await waiting.promise; });
    plugin.hardenPluginDataPermissions = vi.fn(async () => {});
    const saving = plugin.saveSettings(); await entered.promise;
    plugin.onunload(); waiting.resolve(); await saving;
    expect(plugin.hardenPluginDataPermissions).not.toHaveBeenCalled();
    expect(plugin.store).toBe(store);
    expect(plugin.updateStatusBar).not.toHaveBeenCalled();
  });
  it('does not rebuild runtime after old permission hardening settles following unload', async () => {
    const waiting = deferred(), entered = deferred();
    plugin.saveData = vi.fn(async () => {});
    plugin.hardenPluginDataPermissions = vi.fn(async () => { entered.resolve(); await waiting.promise; });
    const saving = plugin.saveSettings(); await entered.promise;
    plugin.onunload(); waiting.resolve(); await saving;
    expect(plugin.store).toBe(store);
    expect(plugin.updateStatusBar).not.toHaveBeenCalled();
  });
  it('persists current settings and refreshes the active runtime', async () => {
    plugin.saveData = vi.fn(async () => {});
    plugin.hardenPluginDataPermissions = vi.fn(async () => {});
    await plugin.saveSettings();
    expect(plugin.saveData).toHaveBeenCalledWith(plugin.settings);
    expect(plugin.hardenPluginDataPermissions).toHaveBeenCalledTimes(1);
    expect(plugin.store).not.toBe(store);
    expect(plugin.updateStatusBar).toHaveBeenCalledTimes(1);
  });
  it('does not replace settings when an old data read settles after unload', async () => {
    const waiting = deferred(), entered = deferred(), before = plugin.settings;
    plugin.loadData = vi.fn(async () => { entered.resolve(); await waiting.promise; return { folders: { dailyRoot: 'synthetic-old' } }; });
    const loading = plugin.loadSettings(); await entered.promise; plugin.onunload(); waiting.resolve(); await loading;
    expect(plugin.settings).toBe(before);
  });
  it('does not continue loading resources after delayed settings settle on an unloaded plugin', async () => {
    loadHost(); const waiting = deferred(), entered = deferred();
    plugin.loadSettings.mockImplementation(async () => { entered.resolve(); await waiting.promise; });
    const loading = plugin.onload(); await entered.promise; plugin.onunload(); waiting.resolve(); await loading;
    expect(plugin.hardenPluginDataPermissions).not.toHaveBeenCalled();
    expect(plugin.registerView).not.toHaveBeenCalled();
    expect(plugin.registerInterval).not.toHaveBeenCalled();
  });
  it('does not execute deferred layout callbacks after unloading', async () => {
    const layouts = loadHost(); await plugin.onload();
    const bootstrap = vi.spyOn(plugin, 'bootstrapDataFoundation').mockResolvedValue(undefined);
    plugin.onunload(); for (const callback of layouts) callback();
    expect(bootstrap).not.toHaveBeenCalled();
  });
  it('does not install late-read styles after unloading', async () => {
    const waiting = deferred(), entered = deferred(), append = vi.fn();
    vi.stubGlobal('document', { createElement: vi.fn(() => ({ remove: vi.fn() })), head: { appendChild: append } });
    plugin.register = vi.fn(); plugin.app.vault.adapter.read.mockImplementation(async () => { entered.resolve(); await waiting.promise; return 'synthetic-css'; });
    const loading = plugin.injectStyles(); await entered.promise; plugin.onunload(); waiting.resolve(); await loading;
    expect(append).not.toHaveBeenCalled();
    expect(plugin.register).not.toHaveBeenCalled();
  });
  it('does not mutate the removed status bar when its delayed read settles', async () => {
    const waiting = deferred(), entered = deferred(), status = { setText: vi.fn(), toggleClass: vi.fn() };
    plugin.statusBar = status; plugin.updateStatusBar = (LifeOpsPlugin.prototype as any).updateStatusBar;
    store.getDashboardStats = vi.fn(async () => { entered.resolve(); await waiting.promise; return { todoOpen: 0, habitDone: 0, habitTotal: 0, punishmentOpen: false }; });
    const refreshing = plugin.updateStatusBar(); await entered.promise; plugin.onunload(); waiting.resolve(); await refreshing;
    expect(status.setText).not.toHaveBeenCalled();
    expect(status.toggleClass).not.toHaveBeenCalled();
  });
});
