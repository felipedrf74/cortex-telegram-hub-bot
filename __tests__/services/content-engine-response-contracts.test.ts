import { describe, expect, it } from 'vitest';
import type {
  CompetitorResponse,
  FeedbackResponse,
  GapsResponse,
  ReportResponse,
  ScriptResponse,
  SeoResponse,
} from '../../src/services/content-engine';

const operationMetadata = {
  operation_trace: null,
  artifact_refs: [],
  next_actions: [],
  reuse_status: null,
  cost_tier: null,
  quality_report: null,
  claim_ledger: [],
  agent_signals_used: [],
};

describe('Content Engine bounded response contract parity', () => {
  it('uses Python gap and SEO field names with typed degraded metadata', () => {
    const gaps = {
      ...operationMetadata,
      niche: 'ceramics',
      gaps: [{
        topic: 'kiln planning',
        gap_type: 'quality_gap',
        search_demand: 'medium',
        existing_content_quality: 'low',
        opportunity_score: 8,
        suggested_angle: 'Show the decision sequence.',
        suggested_title: 'A clearer kiln plan',
      }],
      duration_ms: 10,
      degraded: false,
      warnings: [],
    } satisfies GapsResponse;
    const seo = {
      ...operationMetadata,
      topic: 'kiln planning',
      clusters: [{
        keyword: 'kiln planning checklist',
        variations: ['kiln schedule checklist'],
        estimated_volume: 'medium',
        competition: 'low',
        opportunity_score: 7,
        content_type: 'tutorial',
        suggested_title: 'Plan a kiln schedule',
        notes: 'Use the phrase naturally.',
      }],
      duration_ms: 11,
      degraded: false,
      warnings: [],
    } satisfies SeoResponse;

    expect(gaps.gaps[0].gap_type).toBe('quality_gap');
    expect(seo.clusters[0].estimated_volume).toBe('medium');
  });

  it('represents withheld strategic and learning outputs without raw payloads', () => {
    const competitor = {
      ...operationMetadata,
      channel: 'bounded channel',
      analysis: {},
      duration_ms: 10,
      degraded: true,
      warnings: ['Provider output did not match the contract.'],
    } satisfies CompetitorResponse;
    const feedback = {
      status: 'logged',
      analysis: {},
      duration_ms: 10,
      degraded: true,
      warnings: ['Provider output did not match the contract.'],
    } satisfies FeedbackResponse;
    const report = {
      period: 'Last 7 Days',
      report: {
        status: 'analysis_unavailable',
        degraded: true,
        data_source_status: 'available',
        reason_code: 'provider_output_invalid',
        videos_published: null,
        outcomes_logged: 2,
        publication_tracking: {
          availability: 'unavailable',
          reason_code: 'CONTENT_PUBLICATION_TRACKING_NOT_SUPPORTED',
          publication_execution: 'not_supported',
        },
        total_views: 400,
        avg_retention: 60,
      },
      duration_ms: 10,
      degraded: true,
      warnings: ['Provider output did not match the contract.'],
    } satisfies ReportResponse;

    expect(competitor.analysis).toEqual({});
    expect(feedback.analysis).toEqual({});
    expect(report.report.status).toBe('analysis_unavailable');
  });

  it('models explicit Python nulls without conflating them with omitted legacy fields', () => {
    const script = {
      topic: 'kiln planning',
      script: 'Use this bounded plan to prepare the next firing.',
      hook: 'Start with the firing deadline.',
      title_options: ['Plan the next kiln firing'],
      sources_used: [],
      estimated_duration: '1:00',
      duration_ms: 10,
      generation_mode: null,
      cache_status: null,
      research_artifact_id: null,
      source_package_id: null,
      voice_card_version: null,
      quality_score: null,
      budget_state: null,
      estimated_cost: null,
      actual_cost: null,
      prompt_budget: null,
      research_route: null,
    } satisfies ScriptResponse;
    const unavailableReport = {
      period: 'Last 7 Days',
      report: {
        status: 'unavailable',
        degraded: true,
        data_source_status: 'unavailable',
        reason_code: 'internal_auth_unavailable',
        message: null,
        videos_published: null,
        outcomes_logged: null,
        publication_tracking: {
          availability: 'unavailable',
          reason_code: 'CONTENT_PUBLICATION_TRACKING_NOT_SUPPORTED',
          publication_execution: 'not_supported',
        },
        total_views: null,
        avg_retention: null,
        best_performer: null,
        worst_performer: null,
        hook_analysis: null,
        trend_direction: null,
      },
      duration_ms: 10,
    } satisfies ReportResponse;

    expect(script.generation_mode).toBeNull();
    expect(unavailableReport.report.outcomes_logged).toBeNull();
  });
});
