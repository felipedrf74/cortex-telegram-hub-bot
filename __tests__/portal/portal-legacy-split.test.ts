import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { describe, expect, it } from 'vitest';

/**
 * Phase 5 section extraction: every dashboard section lives in its own ES
 * module under src/portal/ui and legacy.js is only the shell (auth, fetch
 * wrapper, bridge + event bus, hash router, delegated action dispatcher, boot).
 * These checks keep a section from quietly growing back into the shell and
 * keep the module contract (registration, imports, window-exposed actions)
 * honest without a browser.
 */

const uiDir = path.resolve(__dirname, '../../src/portal/ui');
const portalHtml = fs.readFileSync(path.resolve(__dirname, '../../src/portal/portal.html'), 'utf8');
const read = (file: string) => fs.readFileSync(path.join(uiDir, file), 'utf8');
const legacy = read('legacy.js');
const app = read('app.js');

const EXTRACTED_SECTIONS = ['dashboard', 'users', 'skills', 'ai', 'jobs', 'content'];
const SECTION_ENDPOINT_FINGERPRINTS: Record<string, string> = {
  dashboard: "'/api/usage/summary'",
  users: "'/api/users/funnel'",
  skills: "'/api/skills/toggle'",
  ai: "'/api/model-config'",
  jobs: "'/api/jobs'",
  content: "'/api/v1/admin/content-dashboard'",
};

describe('portal legacy shell after section extraction', () => {
  it('legacy.js parses as a classic script and stays a shell', () => {
    expect(() => new vm.Script(legacy)).not.toThrow();
    // Shell responsibilities that must remain.
    expect(legacy).toContain('async function apiFetch(url, opts = {})');
    expect(legacy).toContain('function navigateTo(section)');
    expect(legacy).toContain('function dispatchPortalAction(event, kind)');
    expect(legacy).toContain("window.NexusPortal.emit('app:start')");
    // Section code that must not creep back in.
    for (const [section, fingerprint] of Object.entries(SECTION_ENDPOINT_FINGERPRINTS)) {
      expect(legacy, `${section} endpoint ${fingerprint} belongs in ui/${section}.js`).not.toContain(fingerprint);
    }
    expect(legacy.split('\n').length).toBeLessThan(700);
  });

  it('every extracted section module parses, registers its section, and is imported by app.js', () => {
    for (const section of EXTRACTED_SECTIONS) {
      const source = read(`${section}.js`);
      expect(() => new vm.Script(source), `${section}.js`).not.toThrow();
      expect(source).toContain(`P.registerSection('${section}'`);
      expect(source).toContain(SECTION_ENDPOINT_FINGERPRINTS[section]);
      expect(app).toContain(`import './${section}.js';`);
      expect(portalHtml).toContain(`data-section="${section}"`);
    }
    expect(app).toContain('P.signalModulesReady();');
  });

  it('the bridge exposes the event bus and helpers the modules destructure', () => {
    for (const member of ['on(event, fn)', 'emit(event, payload)', 'fmtCost:', 'getCurrentSection:', 'setContentScope:', 'signalModulesReady:']) {
      expect(legacy).toContain(member);
    }
    const destructured = /const \{ ([^}]+) \} = P;/;
    const bridgeStart = legacy.indexOf('window.NexusPortal = {');
    const bridge = legacy.slice(bridgeStart, legacy.indexOf('\n  };', bridgeStart));
    for (const section of EXTRACTED_SECTIONS) {
      const match = read(`${section}.js`).match(destructured);
      expect(match, `${section}.js destructures bridge helpers`).toBeTruthy();
      for (const name of match![1].split(',').map((s) => s.trim())) {
        expect(bridge, `bridge helper ${name} used by ${section}.js`).toMatch(new RegExp(`(^|[\\s{,])${name}\\s*[,:(]`, 'm'));
      }
    }
  });

  it('every data-act referenced by markup or modules is exposed on window or declared in the shell', () => {
    const sources = [portalHtml, legacy, ...fs.readdirSync(uiDir).filter((f) => f.endsWith('.js')).map((f) => read(f))];
    const names = new Set<string>();
    for (const source of sources) {
      for (const match of source.matchAll(/data-act=\\?"([A-Za-z_$][\w$]*)\\?"/g)) names.add(match[1]);
    }
    expect(names.size).toBeGreaterThan(20);
    const declared = (name: string) => sources.some((source) =>
      new RegExp(`window\\.${name}\\s*=|function\\s+${name}\\s*\\(|PORTAL_ACTIONS\\.${name}\\s*=`).test(source));
    const missing = [...names].filter((name) => !declared(name));
    expect(missing).toEqual([]);
  });

  it('generated markup never uses inline event handlers (strict script-src)', () => {
    for (const file of fs.readdirSync(uiDir).filter((f) => f.endsWith('.js'))) {
      const handlers = read(file).match(/['"\s]on(click|change|input|submit|keydown|keyup|load)=\\?"/g) ?? [];
      expect(handlers, file).toEqual([]);
    }
  });
});
