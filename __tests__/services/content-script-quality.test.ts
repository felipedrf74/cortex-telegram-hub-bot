import { describe, expect, it } from 'vitest';
import {
  analyzeAndImproveScript,
  buildScriptPreflightBrief,
} from '../../src/services/content-script-quality';

describe('content script quality report', () => {
  it('annotates weak intros and offers a structured suggestion without replacing the input', () => {
    const report = analyzeAndImproveScript({
      topic: 'creator retention',
      script: 'Today we are going to talk about creator retention.\nRetention gets better when proof appears early.',
      hook: '',
      cta: '',
      format: 'Reel',
      preflightBrief: buildScriptPreflightBrief({
        topic: 'creator retention',
        format: 'Reel',
        cta: 'Save this and test one intro.',
      }),
    });

    expect(report.overallScore).toBeGreaterThanOrEqual(94);
    expect(report.revisionActions).toEqual(expect.arrayContaining([
      'weak_intro_rewritten_to_first_three_seconds_hook',
      'platform_visual_direction_added',
    ]));
    expect(report.suggestedScript).toContain('FIRST 3 SECONDS:');
    expect(report.suggestedScript).toContain('[0-3s]');
    expect(report.suggestedScript).toContain('VISUAL DIRECTION:');
    expect(report.suggestedScript).toContain('CTA:');
    expect(report.structuredOutput.beatByBeatScript.some((beat) => /^\[\d+-\d+s\]/.test(beat))).toBe(true);
    expect(report.suggestedScript).not.toMatch(/^Today we are going to talk/i);
  });

  it('flags raw artifacts, unsupported claims, copied requests, and missing proof', () => {
    const report = analyzeAndImproveScript({
      topic: 'growth',
      script: '```json\n{"INTERNAL_ID":"abc"}\nCopy this exact competitor script. This will go viral 100% guaranteed.',
      hook: 'This will go viral 100% guaranteed.',
      cta: 'Follow.',
      format: 'YouTube',
    });

    expect(report.blockers).toContain('raw_script_artifact_blocked');
    expect(report.blockers).toContain('copied_competitor_language_blocked');
    expect(report.complianceWarnings).toContain('unsupported_or_overconfident_claim_review_required');
    expect(report.revisionActions).toContain('proof_or_example_added_before_publish');
    expect(report.overallScore).toBeLessThan(75);
  });

  it('flags long-form pacing when a script is requested as short-form video', () => {
    const report = analyzeAndImproveScript({
      topic: 'retention',
      script: 'Thumbnail promise first. Chapter one sets up the eight minutes. Save this.',
      hook: 'Your intro is too long for a short.',
      cta: 'Save this.',
      format: 'Reel',
    });

    expect(report.complianceWarnings).toContain('platform_mismatch_review_required');
    expect(report.overallScore).toBeLessThan(95);
  });

  it('builds YouTube long-form scripts with title promise, intro compression, retention resets, proof, and CTA', () => {
    const report = analyzeAndImproveScript({
      topic: 'content operating system',
      script: [
        'Open with the title promise and show the dashboard before the first section.',
        'Example: one founder moved from random posts to a weekly proof workflow.',
        'Watch the first section and compare your own workflow this week.',
      ].join('\n'),
      hook: 'Your content calendar is not broken; your proof loop is missing.',
      cta: 'Watch the first section and compare your own workflow this week.',
      format: 'YouTube',
      preflightBrief: buildScriptPreflightBrief({
        topic: 'content operating system',
        format: 'YouTube long-form',
        cta: 'Watch the first section and compare your own workflow this week.',
      }),
    });

    const visualAndEditNotes = [...report.structuredOutput.visualDirection, ...report.structuredOutput.editNotes].join('\n');
    expect(report.overallScore).toBeGreaterThanOrEqual(94);
    expect(visualAndEditNotes).toMatch(/Title\/thumbnail promise/i);
    expect(visualAndEditNotes).toMatch(/Compress the intro/i);
    expect(visualAndEditNotes).toMatch(/retention resets/i);
    expect(report.structuredOutput.proofSourceNotes.join('\n')).toMatch(/proof|example/i);
    expect(report.structuredOutput.cta).toMatch(/Watch|compare/i);
  });

  it('builds TikTok/Reels/Shorts scripts with first-frame hook, captions, sound/editing notes, payoff, and pacing', () => {
    const report = analyzeAndImproveScript({
      topic: 'proof-first creator workflow',
      script: 'Show the old workflow, cut to the proof screen, then save this and test one proof shot.',
      hook: 'Most creators do not need more ideas; they need proof sooner.',
      cta: 'Save this and test one proof shot.',
      format: 'TikTok',
      preflightBrief: buildScriptPreflightBrief({
        topic: 'proof-first creator workflow',
        format: 'TikTok',
        cta: 'Save this and test one proof shot.',
      }),
    });

    const productionGuidance = [
      ...report.structuredOutput.visualDirection,
      ...report.structuredOutput.editNotes,
      report.structuredOutput.promise ?? '',
      ...report.structuredOutput.beatByBeatScript,
    ].join('\n');
    expect(report.overallScore).toBeGreaterThanOrEqual(94);
    expect(report.structuredOutput.firstThreeSeconds).toMatch(/proof sooner/i);
    expect(productionGuidance).toMatch(/First frame/i);
    expect(productionGuidance).toMatch(/captions/i);
    expect(productionGuidance).toMatch(/native sound/i);
    expect(productionGuidance).toMatch(/proof|payoff/i);
    expect(report.structuredOutput.beatByBeatScript).toEqual(expect.arrayContaining([
      expect.stringMatching(/^\[0-3s\]/),
      expect.stringMatching(/^\[3-8s\]/),
    ]));
  });

  it('removes only the generated objective suffix when deriving default beats', () => {
    const report = analyzeAndImproveScript({
      topic: 'proof loops',
      script: '',
      format: 'Reel',
      preflightBrief: buildScriptPreflightBrief({ topic: 'proof loops', format: 'Reel' }),
    });

    expect(report.structuredOutput.beatByBeatScript.join('\n')).toContain('proof loops');
    expect(report.structuredOutput.beatByBeatScript.join('\n')).not.toContain('worth acting on');
  });
});
