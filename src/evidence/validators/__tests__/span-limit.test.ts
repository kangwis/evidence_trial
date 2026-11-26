import { describe, test, expect } from 'vitest';
import { GroundingValidator } from '../grounding';
import { ProvenanceValidator } from '../provenance';
import { EvidenceValidator } from '../evidence-validator';
import type { EvidenceContext, EvidenceItem } from '../../types';

const texts = [
  'Baterainya tahan lama',
  'dengan kapasitas besar',
  'dan pengisian daya cepat',
  'serta suhu tetap dingin',
  'saat dipakai bermain game'
];

const context: EvidenceContext = {
  chunkIndex: 0,
  chunkText: texts.join('\n'),
  chunkSegments: texts.map((text, i) => ({
    index: i + 1,
    start: `00:00:0${i},000`,
    end: `00:00:0${i + 1},000`,
    text
  }))
};

const EXCERPT_3 =
  'Baterainya tahan lama dengan kapasitas besar dan pengisian daya cepat';
const EXCERPT_4 = `${EXCERPT_3} serta suhu tetap dingin`;

const makeEvidence = (excerpt: string): EvidenceItem => ({
  type: 'FACT',
  claim: 'Baterai bertahan lama dengan kapasitas besar',
  source_excerpt: excerpt,
  reviewer_assessment: null
});

describe('SPAN 3 segmen (sah menurut prompt rule 8)', () => {
  test('Grounding: PASS exact, bukan quasi', () => {
    const r = GroundingValidator.validate(EXCERPT_3, context);
    expect(r.status).toBe('PASS');
    expect(r.code).toBeUndefined();
  });

  test('Provenance: PASS exact dengan koordinat 1..3 (bukan QUASI_LITERAL)', () => {
    const r = ProvenanceValidator.resolve(EXCERPT_3, null, context);
    expect(r.result.status).toBe('PASS');
    expect(r.result.code).toBeUndefined();
    expect(r.coordinates).toMatchObject({
      segment_start_index: 1,
      segment_end_index: 3
    });
  });

  test('EvidenceValidator: diterima VALID dengan koordinat', () => {
    const ev = makeEvidence(EXCERPT_3);
    const report = EvidenceValidator.validate(ev, context);
    expect(report.accepted).toBe(true);
    expect(report.finalStatus).toBe('VALID');
    expect(ev.source_coordinates).toMatchObject({
      segment_start_index: 1,
      segment_end_index: 3
    });
  });
});

describe('SPAN 4 segmen (melampaui batas)', () => {
  test('Grounding: FAIL CRITICAL dengan pesan batas 3', () => {
    const r = GroundingValidator.validate(EXCERPT_4, context);
    expect(r.status).toBe('FAIL');
    expect(r.severity).toBe('CRITICAL');
    expect(r.reason).toMatch(/maksimum 3/);
  });

  test('Provenance: FAIL tanpa koordinat', () => {
    const r = ProvenanceValidator.resolve(EXCERPT_4, null, context);
    expect(r.result.status).toBe('FAIL');
    expect(r.coordinates).toBeNull();
    expect(r.result.reason).toMatch(/maksimum 3/);
  });

  test('EvidenceValidator: QUARANTINE', () => {
    const ev = makeEvidence(EXCERPT_4);
    const report = EvidenceValidator.validate(ev, context);
    expect(report.accepted).toBe(false);
    expect(report.finalStatus).toBe('QUARANTINE');
    expect(ev.source_coordinates).toBeNull();
    expect(report.quarantineReason).toMatch(/GROUNDING|PROVENANCE/);
  });
});