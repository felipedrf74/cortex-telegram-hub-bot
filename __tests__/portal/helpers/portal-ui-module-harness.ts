import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { vi } from 'vitest';

/**
 * Runs a `src/portal/ui/*.js` file (classic script, no imports) inside a vm
 * context with a small fake DOM and a fake `window.NexusPortal` bridge, so the
 * section modules can be exercised without a browser or jsdom. Elements are
 * created on demand by id (getElementById / querySelector('#id')); listeners
 * are recorded per element and can be fired with `trigger()`. Timers are
 * recorded, never run.
 */

export interface FakeElement {
  id: string;
  tagName: string;
  hidden: boolean;
  disabled: boolean;
  value: string;
  textContent: string;
  innerHTML: string;
  className: string;
  style: Record<string, string>;
  dataset: Record<string, string>;
  options: unknown[];
  children: unknown[];
  listeners: Record<string, Array<(event: unknown) => unknown>>;
  classSet: Set<string>;
  classList: {
    add: (...names: string[]) => void;
    remove: (...names: string[]) => void;
    toggle: (name: string, force?: boolean) => boolean;
    contains: (name: string) => boolean;
  };
  addEventListener: (type: string, fn: (event: unknown) => unknown) => void;
  removeEventListener: (type: string, fn: (event: unknown) => unknown) => void;
  querySelector: (selector: string) => FakeElement | null;
  querySelectorAll: (selector: string) => FakeElement[];
  getAttribute: (name: string) => string | null;
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  appendChild: (child: unknown) => void;
  remove: () => void;
  focus: () => void;
  click: () => void;
  closest: (selector: string) => FakeElement | null;
  matches: (selector: string) => boolean;
}

export interface FakeResponse {
  ok: boolean;
  status?: number;
  json?: () => Promise<unknown>;
}

export type FetchHandler = (url: string, opts?: Record<string, unknown>) => FakeResponse | Promise<FakeResponse>;

export interface HarnessOptions {
  /** Element ids for which getElementById returns null (simulates missing markup). */
  missingIds?: string[];
  /** Handles P.apiFetch and window.fetch. Defaults to `{ ok: false, status: 404 }`. */
  fetch?: FetchHandler;
  /** Initial content scope returned by P.getContentScope. */
  contentScope?: { userId: string; tenantId: string };
  /** Value returned by P.getCurrentSection. */
  currentSection?: string;
}

export interface Harness {
  context: vm.Context;
  bridge: Record<string, any>;
  document: Record<string, any>;
  calls: Array<{ url: string; opts: Record<string, unknown> | undefined }>;
  timers: { intervals: Array<{ fn: () => void; ms: number }>; timeouts: Array<{ fn: () => void; ms: number }> };
  console: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; log: ReturnType<typeof vi.fn> };
  el: (id: string) => FakeElement;
  /** Fire the listeners an element registered for `type`. */
  trigger: (target: FakeElement | Record<string, any>, type: string, event?: Record<string, unknown>) => void;
  load: (relativeUiPath: string) => void;
  /** Let queued promise callbacks run. */
  settle: () => Promise<void>;
}

function makeElement(id: string, tagName = 'DIV', lookup: (selector: string) => FakeElement | null): FakeElement {
  const classSet = new Set<string>();
  const element: FakeElement = {
    id,
    tagName,
    hidden: false,
    disabled: false,
    value: '',
    textContent: '',
    innerHTML: '',
    get className() { return [...classSet].join(' '); },
    set className(value: string) { classSet.clear(); value.split(/\s+/).filter(Boolean).forEach((c) => classSet.add(c)); },
    style: {},
    dataset: {},
    options: [],
    children: [],
    listeners: {},
    classSet,
    classList: {
      add: (...names) => names.forEach((n) => classSet.add(n)),
      remove: (...names) => names.forEach((n) => classSet.delete(n)),
      toggle: (name, force) => {
        const next = force === undefined ? !classSet.has(name) : force;
        if (next) classSet.add(name); else classSet.delete(name);
        return next;
      },
      contains: (name) => classSet.has(name),
    },
    addEventListener: (type, fn) => { (element.listeners[type] = element.listeners[type] || []).push(fn); },
    removeEventListener: (type, fn) => { element.listeners[type] = (element.listeners[type] || []).filter((f) => f !== fn); },
    querySelector: (selector) => lookup(selector),
    querySelectorAll: () => [],
    getAttribute: (name) => (name === 'id' ? id : null),
    setAttribute: () => {},
    removeAttribute: () => {},
    appendChild: () => {},
    remove: () => {},
    focus: () => {},
    click: () => { (element.listeners.click || []).forEach((fn) => fn({ target: element, preventDefault() {} })); },
    closest: () => null,
    matches: () => false,
  } as FakeElement;
  return element;
}

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null; }
  setItem(key: string, value: string) { this.map.set(key, String(value)); }
  removeItem(key: string) { this.map.delete(key); }
}

export function createPortalUiHarness(options: HarnessOptions = {}): Harness {
  const missing = new Set(options.missingIds ?? []);
  const elements = new Map<string, FakeElement>();
  const lookup = (selector: string): FakeElement | null => {
    const id = selector.startsWith('#') ? selector.slice(1).split(/[\s>\[.:]/)[0] : selector;
    return getById(id);
  };
  const getById = (id: string): FakeElement | null => {
    if (missing.has(id)) return null;
    if (!elements.has(id)) elements.set(id, makeElement(id, id === 'email-form' ? 'FORM' : 'DIV', lookup));
    return elements.get(id)!;
  };
  const el = (id: string): FakeElement => {
    const found = getById(id);
    if (!found) throw new Error(`element ${id} is configured as missing`);
    return found;
  };

  const calls: Harness['calls'] = [];
  const fetchHandler: FetchHandler = options.fetch ?? (() => ({ ok: false, status: 404, json: async () => ({}) }));
  const doFetch = async (url: string, opts?: Record<string, unknown>) => {
    calls.push({ url, opts });
    return fetchHandler(url, opts);
  };

  const timers: Harness['timers'] = { intervals: [], timeouts: [] };
  const documentListeners: Record<string, Array<(event: unknown) => unknown>> = {};
  const document: Record<string, any> = {
    hidden: false,
    body: makeElement('body', 'BODY', lookup),
    documentElement: makeElement('html', 'HTML', lookup),
    getElementById: (id: string) => getById(id),
    querySelector: (selector: string) => lookup(selector),
    querySelectorAll: () => [],
    createElement: (tag: string) => makeElement(`created-${tag}-${elements.size}`, tag.toUpperCase(), lookup),
    addEventListener: (type: string, fn: (event: unknown) => unknown) => { (documentListeners[type] = documentListeners[type] || []).push(fn); },
    removeEventListener: () => {},
    listeners: documentListeners,
  };

  let scope = options.contentScope ?? { userId: '', tenantId: '' };
  const listeners: Record<string, Array<(payload: unknown) => void>> = Object.create(null);
  const bridge: Record<string, any> = {
    apiFetch: doFetch,
    apiJson: async (url: string, opts?: Record<string, unknown>) => {
      const res = await doFetch(url, opts);
      if (!res.ok) throw new Error(`HTTP ${res.status ?? 500}`);
      return res.json ? res.json() : {};
    },
    esc: (value: unknown) => String(value ?? ''),
    shortDateTime: () => 'now',
    relativeTime: () => 'now',
    fmtNum: (value: unknown) => String(value ?? '—'),
    fmtCost: (value: unknown) => '$' + String(value ?? '—'),
    showToast: vi.fn(),
    adminLoadErrorMessage: (err: unknown) => String((err as Error)?.message ?? err),
    navigateTo: vi.fn(),
    getContentScope: () => ({ ...scope }),
    setContentScope: (next: { userId?: string; tenantId?: string }) => { scope = { userId: next.userId || '', tenantId: next.tenantId || '' }; },
    getCurrentSection: () => options.currentSection ?? 'dashboard',
    refreshSupportBadge: vi.fn(),
    refreshIssueBadge: vi.fn(),
    signalModulesReady: vi.fn(),
    sections: {},
    registerSection(id: string, def: Record<string, unknown>) { this.sections[id] = def; },
    activateSection: vi.fn(),
    deactivateSections: vi.fn(),
    on(event: string, fn: (payload: unknown) => void) { (listeners[event] = listeners[event] || []).push(fn); return () => this.off(event, fn); },
    off(event: string, fn: (payload: unknown) => void) { listeners[event] = (listeners[event] || []).filter((f) => f !== fn); },
    emit(event: string, payload?: unknown) { (listeners[event] || []).slice().forEach((fn) => fn(payload)); },
  };

  const consoleSpies = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
  const sandbox: Record<string, any> = {
    document,
    location: { hash: '', hostname: 'localhost', search: '', pathname: '/admin', href: 'http://localhost/admin' },
    history: { replaceState: vi.fn() },
    localStorage: new MemoryStorage(),
    sessionStorage: new MemoryStorage(),
    crypto: { randomUUID: () => 'uuid-test' },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: doFetch,
    console: consoleSpies,
    confirm: () => true,
    alert: () => {},
    setInterval: (fn: () => void, ms: number) => { timers.intervals.push({ fn, ms }); return timers.intervals.length; },
    clearInterval: () => {},
    setTimeout: (fn: () => void, ms: number) => { timers.timeouts.push({ fn, ms }); return timers.timeouts.length; },
    clearTimeout: () => {},
    URL,
    URLSearchParams,
    Blob: class { constructor(public parts: unknown[]) {} },
    NexusPortal: bridge,
    // The shell installs a MutationObserver for data-* driven styles; record it, never fire it.
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
  };
  // window-level listeners the shell installs (hashchange, etc.) are recorded like document's.
  const windowListeners: Record<string, Array<(event: unknown) => unknown>> = {};
  sandbox.addEventListener = (type: string, fn: (event: unknown) => unknown) => { (windowListeners[type] = windowListeners[type] || []).push(fn); };
  sandbox.removeEventListener = () => {};
  sandbox.windowListeners = windowListeners;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);

  const uiDir = path.resolve(__dirname, '../../../src/portal/ui');
  return {
    context,
    bridge,
    document,
    calls,
    timers,
    console: consoleSpies,
    el,
    trigger(target, type, event = {}) {
      const fns = (target as any).listeners?.[type] ?? [];
      fns.forEach((fn: (event: unknown) => unknown) => fn({ target, preventDefault() {}, ...event }));
    },
    load(relativeUiPath) {
      const file = path.join(uiDir, relativeUiPath);
      new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }).runInContext(context);
    },
    async settle() {
      for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}
