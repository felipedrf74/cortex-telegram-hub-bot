import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('editorial compatibility static exit inventory', () => {
  it('keeps Decision Center and Radar on canonical workspace adapters', () => {
    for (const path of [
      'src/services/decision-center.ts',
      'src/services/decision-command-effects.ts',
      'src/services/decision-domain-state-revision.ts',
      'src/services/content-radar-engine.ts',
    ]) {
      expect(read(path), path).not.toContain("from './content-editorial-workflow'");
    }
    expect(read('src/services/decision-center/command-service.ts')).toContain("from '../content-workspace-decision-adapter'");
    expect(read('src/services/decision-center.ts')).toContain("from './decision-center/command-service'");
    expect(read('src/services/content-radar-engine.ts')).toContain("from './content-workspace'");
  });

  it('keeps the deprecated facade incapable of writing canonical roots or historical ledgers', () => {
    const facade = read('src/services/content-editorial-workflow.ts');
    expect(facade).not.toMatch(/INSERT\s+INTO\s+content_domain_objects/i);
    expect(facade).not.toMatch(/UPDATE\s+content_domain_objects/i);
    expect(facade).not.toMatch(/DELETE\s+FROM\s+content_domain_objects/i);
    expect(facade).not.toMatch(/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+content_approval_records/i);
    expect(facade).not.toMatch(/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+content_source_review_records/i);
    expect(facade).not.toContain('submitSecretarySchedulingIntent');
  });

  it('keeps old HTTP routes presentation-only for scheduling and publication', () => {
    const routes = read('src/api/routes/content-editorial-routes.ts');
    expect(routes).not.toContain('loadLiveCalendarBusyWindows');
    expect(routes).not.toContain('submitSecretarySchedulingIntent');
    expect(routes).toContain("publicationExecution: 'not_performed'");
  });
});
