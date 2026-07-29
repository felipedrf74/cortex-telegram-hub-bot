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

  it.each([
    {
      language: 'pt-BR',
      hook: 'O erro em fluxo criativo não é falta de esforço; é falta da prova que faz as pessoas se importarem.',
      cta: 'Salve isto e teste o primeiro passo hoje.',
      title: 'O erro em fluxo criativo que ninguém percebe',
      sourceNote: 'Pesquisa de retenção: Use como contexto de apoio.',
      proofFallback: 'Adicione um exemplo concreto, demonstração, fonte ou prova de antes e depois antes de publicar.',
      longCta: 'Escolha uma ação deste vídeo e meça o resultado nesta semana.',
      heading: 'PRIMEIROS 3 SEGUNDOS:',
      visual: 'Primeiro quadro:',
    },
    {
      language: 'pt-PT',
      hook: 'O erro em fluxo criativo não é a falta de esforço; é a falta da prova que faz as pessoas interessarem-se.',
      cta: 'Guarda isto e testa o primeiro passo hoje.',
      title: 'O erro em fluxo criativo que ninguém nota',
      sourceNote: 'Pesquisa de retenção: Usa como contexto de apoio.',
      proofFallback: 'Adiciona um exemplo concreto, demonstração, fonte ou prova de antes e depois antes de publicar.',
      longCta: 'Escolhe uma ação deste vídeo e mede o resultado esta semana.',
      heading: 'PRIMEIROS 3 SEGUNDOS:',
      visual: 'Primeiro plano:',
    },
  ] as const)(
    'keeps every synthesized fallback in $language when hook and CTA are missing',
    ({ language, hook, cta, title, sourceNote, proofFallback, longCta, heading, visual }) => {
      const topic = 'fluxo criativo';
      const sources = [{ title: 'Pesquisa de retenção' }];
      const preflightBrief = buildScriptPreflightBrief({
        topic,
        format: 'Reel',
        language,
        sources,
      });
      const report = analyzeAndImproveScript({
        topic,
        script: '',
        hook: '',
        cta: '',
        titleOptions: [],
        format: 'Reel',
        sources,
        // The language carried by a preflight brief must be sufficient for
        // callers that construct the brief before running quality analysis.
        preflightBrief,
      });
      const noSourcePreflight = buildScriptPreflightBrief({
        topic,
        format: 'YouTube',
        language,
      });
      const longFormReport = analyzeAndImproveScript({
        topic,
        script: '',
        hook: '',
        cta: '',
        titleOptions: [],
        format: 'YouTube',
        language,
        preflightBrief: noSourcePreflight,
      });
      const synthesizedText = JSON.stringify({
        preflightBrief,
        noSourcePreflight,
        structuredOutput: report.structuredOutput,
        suggestedScript: report.suggestedScript,
        longFormStructuredOutput: longFormReport.structuredOutput,
        longFormSuggestedScript: longFormReport.suggestedScript,
      });

      expect(preflightBrief.language).toBe(language);
      expect(report.structuredOutput.firstThreeSeconds).toBe(hook);
      expect(report.structuredOutput.cta).toBe(cta);
      expect(report.structuredOutput.titleOptions[0]).toBe(title);
      expect(report.structuredOutput.proofSourceNotes).toContain(sourceNote);
      expect(report.structuredOutput.visualDirection[0]).toContain(visual);
      expect(report.suggestedScript).toContain(heading);
      expect(noSourcePreflight.proofLibrary).toEqual([proofFallback]);
      expect(longFormReport.structuredOutput.cta).toBe(longCta);
      expect(synthesizedText).toContain(topic);
      expect(synthesizedText).toContain('Pesquisa de retenção');

      for (const retiredEnglishFallback of [
        'specific audience for this topic',
        'worth acting on',
        'Add one concrete example',
        'Use a clear creator voice',
        'Deliver the title/thumbnail promise',
        'The fluxo criativo mistake',
        'Save this and test',
        'Pick one action from this video',
        'In under a minute',
        'Show the audience',
        'Name the specific tension',
        'First frame: creator',
        'Title/thumbnail promise should match',
        'Cut dead air aggressively',
        'Compress the intro',
        'Use as supporting context',
        'Review factual claims',
        'VISUAL DIRECTION:',
        'EDIT NOTES:',
        'RISK / CLAIM NOTES:',
      ]) {
        expect(synthesizedText).not.toContain(retiredEnglishFallback);
      }
    },
  );
});
