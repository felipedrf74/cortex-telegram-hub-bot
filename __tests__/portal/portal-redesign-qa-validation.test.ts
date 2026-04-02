/**
 * QA Validation — Status Portal Redesign
 *
 * Validates: FRONTEND: Redesign Nexus Hub Status Portal — industry-standard dashboard layout
 * Validates structural correctness of the portal.html UI layout, sections, and JavaScript.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const PORTAL_PATH = path.resolve(__dirname, '../../src/portal/portal.html');
let portalSource: string;

beforeAll(() => {
  portalSource = fs.readFileSync(PORTAL_PATH, 'utf8');
});

describe('Portal Redesign — Layout structure', () => {
  it('has sticky header with title and status indicators', () => {
    expect(portalSource).toContain('class="header"');
    expect(portalSource).toContain('Nexus Hub Status Portal');
    expect(portalSource).toContain('position: sticky');
    expect(portalSource).toContain('id="uptime"');
    expect(portalSource).toContain('id="poll-status"');
  });

  it('has health summary bar with all key metrics', () => {
    expect(portalSource).toContain('class="health-bar"');
    expect(portalSource).toContain('id="hb-jobs"');
    expect(portalSource).toContain('id="hb-emails"');
    expect(portalSource).toContain('id="hb-api"');
    expect(portalSource).toContain('id="hb-invoices"');
    expect(portalSource).toContain('id="hb-garmin"');
    expect(portalSource).toContain('id="hb-errors"');
    expect(portalSource).toContain('id="hb-sentry"');
    expect(portalSource).toContain('id="hb-uptime"');
    expect(portalSource).toContain('id="hb-health-status"');
    expect(portalSource).toContain('id="hb-db-status"');
    expect(portalSource).toContain('id="hb-mem"');
  });

  it('uses 2-column responsive grid with mobile breakpoint', () => {
    expect(portalSource).toContain('grid-template-columns: 1fr 1fr');
    expect(portalSource).toContain('@media (max-width: 900px)');
    expect(portalSource).toContain('grid-template-columns: 1fr');
  });

  it('has full-width card class for spanning sections', () => {
    expect(portalSource).toContain('card-full');
    expect(portalSource).toContain('grid-column: 1 / -1');
  });
});

describe('Portal Redesign — Dashboard sections', () => {
  const REQUIRED_SECTIONS = [
    "Today's Timeline",
    'Job Calendar',
    'Bot Status',
    'Domain Handlers',
    'Skill Modules',
    'API Usage',
    'Next Scheduled Runs',
    'Email Automations',
    'Adapter Status',
    'Integration Health',
    'Invoices',
    'Content References',
    'Scheduled Jobs',
    'Quick Actions',
    'Content Agent Mesh',
    'Activity Log',
  ];

  for (const section of REQUIRED_SECTIONS) {
    it(`includes "${section}" section`, () => {
      expect(portalSource).toContain(section);
    });
  }
});

describe('Portal Redesign — Design tokens', () => {
  it('defines CSS custom properties for consistent theming', () => {
    expect(portalSource).toContain('--bg:');
    expect(portalSource).toContain('--surface:');
    expect(portalSource).toContain('--border:');
    expect(portalSource).toContain('--text:');
    expect(portalSource).toContain('--text2:');
    expect(portalSource).toContain('--accent:');
    expect(portalSource).toContain('--green:');
    expect(portalSource).toContain('--red:');
    expect(portalSource).toContain('--yellow:');
    expect(portalSource).toContain('--blue:');
  });

  it('uses dark theme colors', () => {
    // Background should be dark
    expect(portalSource).toMatch(/--bg:\s*#0f1117/);
    expect(portalSource).toMatch(/--surface:\s*#1a1d27/);
  });
});

describe('Portal Redesign — Security', () => {
  it('has XSS escaping function defined', () => {
    expect(portalSource).toContain('function esc(s)');
    expect(portalSource).toContain('textContent');
    expect(portalSource).toContain('.innerHTML');
  });

  it('uses esc() for user-controlled content in skill rendering', () => {
    // Skill names should be escaped
    expect(portalSource).toContain('esc(skill.name)');
  });

  it('has authentication token support', () => {
    expect(portalSource).toContain('portal_token');
    expect(portalSource).toContain('Authorization');
    expect(portalSource).toContain('Bearer');
  });
});

describe('Portal Redesign — JavaScript functionality', () => {
  it('polls for updates at 10-second interval', () => {
    expect(portalSource).toContain('POLL_MS = 10_000');
  });

  it('has API fetch wrapper with auth', () => {
    expect(portalSource).toContain('async function apiFetch');
    expect(portalSource).toContain('status === 401');
  });

  it('has time formatting utilities', () => {
    expect(portalSource).toContain('function shortTime');
    expect(portalSource).toContain('function shortDateTime');
    expect(portalSource).toContain('function relativeTime');
  });

  it('has toast notification system', () => {
    expect(portalSource).toContain('id="toast"');
    expect(portalSource).toContain('class="toast"');
  });
});

describe('Portal Redesign — Timeline & Calendar', () => {
  it('timeline has hour marks and track containers', () => {
    expect(portalSource).toContain('id="timeline-hours"');
    expect(portalSource).toContain('id="timeline-track"');
  });

  it('timeline has domain color legend', () => {
    expect(portalSource).toContain('Secretary');
    expect(portalSource).toContain('Triathlon');
    expect(portalSource).toContain('Content');
  });

  it('calendar has 7-column grid (days of week)', () => {
    expect(portalSource).toContain('grid-template-columns: repeat(7, 1fr)');
  });

  it('calendar has navigation (prev/today/next)', () => {
    expect(portalSource).toContain('calNavigate(-1)');
    expect(portalSource).toContain('calNavigate(0)');
    expect(portalSource).toContain('calNavigate(1)');
  });
});

describe('Portal Redesign — Quick Actions', () => {
  it('has actions grid with responsive columns', () => {
    expect(portalSource).toContain('actions-grid');
    expect(portalSource).toContain('repeat(auto-fill, minmax(200px, 1fr))');
  });
});
