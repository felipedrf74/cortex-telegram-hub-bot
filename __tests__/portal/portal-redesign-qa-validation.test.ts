/**
 * QA Validation: Portal Redesign — Industry-standard dashboard layout
 *
 * Validates the frontend agent's complete UI/UX overhaul of portal.html:
 * - Design tokens & CSS variables
 * - Sidebar navigation with sections
 * - Top bar with status pill & health summary
 * - Card system, stat boxes, grid layouts
 * - Responsive design (media queries, mobile sidebar toggle)
 * - Section structure & navigation anchors
 * - Domain handler card redesign
 * - Table styling & badge system
 * - Timeline, calendar, and activity log sections
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

let html: string;

beforeAll(() => {
  html = fs.readFileSync(
    path.join(__dirname, '../../src/portal/portal.html'),
    'utf-8',
  );
});

// ── Design Tokens ─────────────────────────────────
describe('Portal Redesign — Design Tokens', () => {
  it('defines CSS custom properties on :root', () => {
    expect(html).toContain(':root');
    expect(html).toContain('--bg:');
    expect(html).toContain('--surface:');
    expect(html).toContain('--border:');
    expect(html).toContain('--text:');
    expect(html).toContain('--accent:');
  });

  it('has semantic color tokens for status indicators', () => {
    expect(html).toContain('--green:');
    expect(html).toContain('--red:');
    expect(html).toContain('--yellow:');
    expect(html).toContain('--blue:');
    expect(html).toContain('--purple:');
    expect(html).toContain('--orange:');
  });

  it('has dim variants for background tinting', () => {
    expect(html).toContain('--green-dim:');
    expect(html).toContain('--red-dim:');
    expect(html).toContain('--yellow-dim:');
    expect(html).toContain('--blue-dim:');
    expect(html).toContain('--purple-dim:');
  });

  it('defines layout tokens for sidebar and header', () => {
    expect(html).toContain('--sidebar-w:');
    expect(html).toContain('--header-h:');
  });

  it('defines border radius tokens', () => {
    expect(html).toContain('--radius:');
    expect(html).toContain('--radius-sm:');
    expect(html).toContain('--radius-xs:');
  });

  it('defines shadow and transition tokens', () => {
    expect(html).toContain('--shadow-card:');
    expect(html).toContain('--shadow-hover:');
    expect(html).toContain('--transition:');
  });
});

// ── Sidebar ───────────────────────────────────────
describe('Portal Redesign — Sidebar Navigation', () => {
  it('has a fixed sidebar element', () => {
    expect(html).toContain('class="sidebar"');
    expect(html).toContain('position: fixed');
  });

  it('has sidebar brand with logo and title', () => {
    expect(html).toContain('sidebar-brand');
    expect(html).toContain('Nexus Hub');
    expect(html).toContain('class="logo"');
  });

  it('has navigation sections with labels', () => {
    expect(html).toContain('nav-section-label');
    expect(html).toContain('Overview');
    expect(html).toContain('System');
    expect(html).toContain('Data');
    expect(html).toContain('Agents');
    expect(html).toContain('Operations');
  });

  it('has navigation items with icons', () => {
    expect(html).toContain('nav-item');
    expect(html).toContain('nav-icon');
  });

  it('navigation links have onclick scroll handlers', () => {
    expect(html).toMatch(/onclick="scrollToSection\('/);
  });

  it('sidebar has all key navigation targets', () => {
    const navTargets = [
      'overview', 'timeline', 'calendar', 'domains',
      'jobs', 'integrations', 'ai-providers', 'emails',
      'invoices', 'content', 'agent-mesh', 'actions', 'activity',
    ];
    for (const target of navTargets) {
      expect(html).toContain(`scrollToSection('${target}')`);
    }
  });

  it('sidebar footer shows uptime/version info', () => {
    expect(html).toContain('sidebar-footer');
    expect(html).toContain('id="sidebar-uptime"');
  });

  it('active nav item has highlight style', () => {
    expect(html).toContain('.nav-item.active');
    expect(html).toMatch(/nav-item active/);
  });

  it('nav badge CSS exists for notification counts', () => {
    expect(html).toContain('.nav-item .nav-badge');
  });
});

// ── Top Bar ───────────────────────────────────────
describe('Portal Redesign — Top Bar & Health Summary', () => {
  it('has a sticky top bar', () => {
    expect(html).toContain('class="topbar"');
    expect(html).toContain('position: sticky');
    expect(html).toContain('backdrop-filter: blur');
  });

  it('top bar shows portal title', () => {
    expect(html).toContain('Status Portal');
  });

  it('has a connection status pill', () => {
    expect(html).toContain('status-pill');
    expect(html).toContain('id="poll-status"');
  });

  it('status pill has warn and error variants', () => {
    expect(html).toContain('.status-pill.warn');
    expect(html).toContain('.status-pill.err');
  });

  it('has a health summary bar below top bar', () => {
    expect(html).toContain('class="health-bar"');
    expect(html).toContain('id="health-bar"');
  });

  it('health bar shows key metrics', () => {
    expect(html).toContain('id="hb-jobs"');
    expect(html).toContain('id="hb-emails"');
    expect(html).toContain('id="hb-api"');
    expect(html).toContain('id="hb-invoices"');
    expect(html).toContain('id="hb-uptime"');
  });

  it('health items have monospace values', () => {
    expect(html).toContain('.health-item .val');
    expect(html).toMatch(/font-family:.*monospace/);
  });
});

// ── Card System ───────────────────────────────────
describe('Portal Redesign — Card System & Grid Layout', () => {
  it('has a card component with proper styling', () => {
    expect(html).toContain('.card');
    expect(html).toContain('background: var(--surface)');
    expect(html).toContain('border-radius: var(--radius)');
  });

  it('cards have hover shadow effect', () => {
    expect(html).toContain('.card:hover');
    expect(html).toContain('var(--shadow-hover)');
  });

  it('supports 2-column and 3-column grid layouts', () => {
    expect(html).toContain('.grid-2');
    expect(html).toContain('.grid-3');
    expect(html).toContain('.grid-full');
  });

  it('grid uses CSS grid with gap', () => {
    expect(html).toContain('display: grid');
    expect(html).toContain('gap: 16px');
  });

  it('has card header with title and actions slots', () => {
    expect(html).toContain('.card-header');
    expect(html).toContain('.card-title');
    expect(html).toContain('.card-actions');
  });

  it('card title has icon slot', () => {
    expect(html).toContain('.card-title .icon');
  });

  it('stat boxes have value and label', () => {
    expect(html).toContain('.stat-box');
    expect(html).toContain('.stat-value');
    expect(html).toContain('.stat-label');
  });

  it('stat values use tabular numbers', () => {
    expect(html).toContain("font-feature-settings: 'tnum' 1");
  });
});

// ── Section Structure ─────────────────────────────
describe('Portal Redesign — Section Structure', () => {
  it('has section headers with horizontal rules', () => {
    expect(html).toContain('.section-header');
    expect(html).toContain('.section-line');
  });

  it('section headers use uppercase labels', () => {
    expect(html).toContain('text-transform: uppercase');
  });

  it('has all major dashboard sections', () => {
    const sections = [
      'id="overview"',
      'id="timeline"',
      'id="calendar"',
      'id="domains"',
      'id="jobs"',
      'id="integrations"',
      'id="ai-providers"',
    ];
    for (const section of sections) {
      expect(html).toContain(section);
    }
  });

  it('overview section has bot status and API usage cards', () => {
    expect(html).toContain('Bot Status');
    expect(html).toContain('API Usage');
  });

  it('jobs section has next-runs and all-jobs tables', () => {
    expect(html).toContain('id="next-runs-table"');
    expect(html).toContain('id="jobs-table"');
  });

  it('integrations section has health and email cards', () => {
    expect(html).toContain('Integration Health');
    expect(html).toContain('Email Automations');
  });

  it('AI providers section exists', () => {
    expect(html).toContain('AI Providers & Fallback Chain');
  });
});

// ── Domain Handler Cards ──────────────────────────
describe('Portal Redesign — Domain Handler Cards', () => {
  it('domain handlers use a responsive grid', () => {
    expect(html).toContain('.domain-grid');
    expect(html).toMatch(/grid-template-columns:.*repeat\(auto-fill/);
  });

  it('domain cards have accent border-left', () => {
    expect(html).toContain('.domain-card');
    expect(html).toContain('border-left: 3px solid');
  });

  it('domain cards have header, stats, and details sections', () => {
    expect(html).toContain('.domain-card-header');
    expect(html).toContain('.domain-card-stats');
    expect(html).toContain('.domain-card-details');
  });

  it('domain tag color classes exist for each domain', () => {
    expect(html).toContain('.domain-secretary');
    expect(html).toContain('.domain-triathlon');
    expect(html).toContain('.domain-content');
    expect(html).toContain('.domain-invoices');
    expect(html).toContain('.domain-system');
  });

  it('domain section has Pre-skill modules badge', () => {
    expect(html).toContain('Pre-skill modules');
    expect(html).toContain('section-badge');
  });
});

// ── Badge System ──────────────────────────────────
describe('Portal Redesign — Badge System', () => {
  it('has base badge component', () => {
    expect(html).toContain('.badge');
  });

  it('has semantic badge variants', () => {
    expect(html).toContain('.badge-success');
    expect(html).toContain('.badge-failed');
    expect(html).toContain('.badge-running');
    expect(html).toContain('.badge-never');
    expect(html).toContain('.badge-configured');
    expect(html).toContain('.badge-not-configured');
  });
});

// ── Table Styling ─────────────────────────────────
describe('Portal Redesign — Table Styling', () => {
  it('tables are full-width with collapsed borders', () => {
    expect(html).toContain('width: 100%');
    expect(html).toContain('border-collapse: collapse');
  });

  it('table headers have uppercase styling', () => {
    // th has text-transform uppercase
    expect(html).toMatch(/th\s*\{[^}]*text-transform:\s*uppercase/s);
  });

  it('table rows have hover state', () => {
    expect(html).toContain('tr:hover td');
  });

  it('last row has no bottom border', () => {
    expect(html).toContain('tr:last-child td');
    expect(html).toContain('border-bottom: none');
  });
});

// ── Responsive Design ─────────────────────────────
describe('Portal Redesign — Responsive Design', () => {
  it('has viewport meta tag for mobile', () => {
    expect(html).toContain('width=device-width, initial-scale=1.0');
  });

  it('has media query for tablet breakpoint (1100px)', () => {
    expect(html).toContain('@media (max-width: 1100px)');
  });

  it('tablet breakpoint collapses grids to single column', () => {
    // Grid-2 and grid-3 go to 1fr at 1100px
    expect(html).toMatch(/@media\s*\(max-width:\s*1100px\)\s*\{[^}]*grid-template-columns:\s*1fr/s);
  });

  it('has media query for mobile breakpoint (768px)', () => {
    expect(html).toContain('@media (max-width: 768px)');
  });

  it('mobile breakpoint hides sidebar', () => {
    expect(html).toContain('.sidebar { transform: translateX(-100%)');
  });

  it('has mobile sidebar toggle button', () => {
    expect(html).toContain('sidebar-toggle');
    expect(html).toContain('id="sidebar-toggle"');
    expect(html).toContain('toggleSidebar()');
  });

  it('has sidebar overlay for mobile', () => {
    expect(html).toContain('sidebar-overlay');
    expect(html).toContain('.sidebar-overlay.open');
  });

  it('main content removes margin on mobile', () => {
    expect(html).toContain('.main { margin-left: 0');
  });
});

// ── Timeline Section ──────────────────────────────
describe('Portal Redesign — Timeline Section', () => {
  it('has timeline container', () => {
    expect(html).toContain('id="timeline-view"');
    expect(html).toContain('id="timeline-track"');
    expect(html).toContain('id="timeline-hours"');
  });

  it('timeline has domain legend', () => {
    expect(html).toContain('timeline-legend');
    // Verify at least a few domain colors are in the legend
    expect(html).toMatch(/timeline-legend-dot.*Secretary/s);
    expect(html).toMatch(/timeline-legend-dot.*Triathlon/s);
    expect(html).toMatch(/timeline-legend-dot.*Content/s);
  });

  it('timeline has a Now indicator', () => {
    expect(html).toContain('>Now<');
  });
});

// ── Calendar Section ──────────────────────────────
describe('Portal Redesign — Calendar Section', () => {
  it('has calendar grid container', () => {
    expect(html).toContain('id="cal-grid"');
    expect(html).toContain('id="cal-title"');
  });

  it('has calendar navigation buttons', () => {
    expect(html).toContain('calNavigate(-1)');
    expect(html).toContain('calNavigate(0)');
    expect(html).toContain('calNavigate(1)');
  });

  it('calendar has color legend', () => {
    expect(html).toContain('cal-legend');
    expect(html).toContain('Success');
    expect(html).toContain('Failed');
    expect(html).toContain('Scheduled');
  });
});

// ── Status Dots ───────────────────────────────────
describe('Portal Redesign — Status Indicators', () => {
  it('status dots are 7px circles', () => {
    expect(html).toContain('.status-dot');
    expect(html).toMatch(/\.status-dot\s*\{[^}]*width:\s*7px/s);
    expect(html).toMatch(/\.status-dot\s*\{[^}]*height:\s*7px/s);
    expect(html).toMatch(/\.status-dot\s*\{[^}]*border-radius:\s*50%/s);
  });

  it('green, red, and yellow dot variants have glow effects', () => {
    expect(html).toContain('.dot-green');
    expect(html).toContain('.dot-red');
    expect(html).toContain('.dot-yellow');
    // All three should have box-shadow
    expect(html).toMatch(/\.dot-green\s*\{[^}]*box-shadow/s);
    expect(html).toMatch(/\.dot-red\s*\{[^}]*box-shadow/s);
    expect(html).toMatch(/\.dot-yellow\s*\{[^}]*box-shadow/s);
  });
});

// ── Bot Status Card ───────────────────────────────
describe('Portal Redesign — Bot Status Card', () => {
  it('has bot status indicators', () => {
    expect(html).toContain('id="bot-polling"');
    expect(html).toContain('id="bot-last-msg"');
    expect(html).toContain('id="bot-uptime"');
  });
});

// ── API Usage Card ────────────────────────────────
describe('Portal Redesign — API Usage Card', () => {
  it('has API cost and call stat boxes', () => {
    expect(html).toContain('id="api-today-cost"');
    expect(html).toContain('id="api-today-calls"');
    expect(html).toContain('id="api-7d-cost"');
    expect(html).toContain('id="api-30d-cost"');
  });

  it('has API category breakdown table', () => {
    expect(html).toContain('id="api-categories"');
  });
});

// ── Email Section ─────────────────────────────────
describe('Portal Redesign — Email Automations', () => {
  it('has email sent/failed counters', () => {
    expect(html).toContain('id="email-sent-today"');
    expect(html).toContain('id="email-failed-today"');
  });

  it('has email log table', () => {
    expect(html).toContain('id="email-log-table"');
  });
});

// ── Dark Theme Consistency ────────────────────────
describe('Portal Redesign — Dark Theme', () => {
  it('body background uses darkest token', () => {
    expect(html).toContain('background: var(--bg)');
  });

  it('uses system font stack with Inter', () => {
    expect(html).toMatch(/font-family:.*Inter/);
  });

  it('surface hierarchy is darker → lighter', () => {
    // Extract hex values from CSS variables
    const bgMatch = html.match(/--bg:\s*(#[0-9a-f]+)/i);
    const surfaceMatch = html.match(/--surface:\s*(#[0-9a-f]+)/i);
    const surface2Match = html.match(/--surface2:\s*(#[0-9a-f]+)/i);
    expect(bgMatch).not.toBeNull();
    expect(surfaceMatch).not.toBeNull();
    expect(surface2Match).not.toBeNull();

    // Convert hex to brightness (simple sum of RGB)
    const hexToBrightness = (hex: string) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return r + g + b;
    };

    const bgBrightness = hexToBrightness(bgMatch![1]);
    const surfaceBrightness = hexToBrightness(surfaceMatch![1]);
    const surface2Brightness = hexToBrightness(surface2Match![1]);

    // Each layer should be progressively lighter
    expect(surfaceBrightness).toBeGreaterThan(bgBrightness);
    expect(surface2Brightness).toBeGreaterThan(surfaceBrightness);
  });
});

// ── JavaScript Functionality ──────────────────────
describe('Portal Redesign — JavaScript Functions', () => {
  it('defines scrollToSection function', () => {
    expect(html).toMatch(/scrollToSection\s*=\s*function/);
  });

  it('defines toggleSidebar function', () => {
    expect(html).toMatch(/toggleSidebar\s*=\s*function/);
  });

  it('defines poll function for auto-refresh', () => {
    expect(html).toMatch(/function\s+poll\b/);
  });

  it('has polling interval set up', () => {
    expect(html).toMatch(/setInterval\s*\(\s*poll/);
  });

  it('has toast notification function', () => {
    expect(html).toMatch(/function\s+showToast/);
  });

  it('defines apiFetch for authenticated requests', () => {
    expect(html).toMatch(/function\s+apiFetch|const\s+apiFetch|apiFetch\s*=/);
  });
});

// ── Accessibility Basics ──────────────────────────
describe('Portal Redesign — Accessibility', () => {
  it('has lang attribute on html element', () => {
    expect(html).toContain('<html lang="en">');
  });

  it('has charset meta tag', () => {
    expect(html).toContain('charset="UTF-8"');
  });

  it('has descriptive page title', () => {
    expect(html).toMatch(/<title>.*Nexus Hub.*<\/title>/);
  });

  it('sidebar uses semantic aside element', () => {
    expect(html).toContain('<aside');
  });

  it('sidebar uses semantic nav element', () => {
    expect(html).toContain('<nav');
  });
});
