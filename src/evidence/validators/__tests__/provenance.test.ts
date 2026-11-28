import { describe, test, expect } from 'vitest';
import { ProvenanceValidator, selectProductHint } from '../provenance';
import type { EvidenceContext } from '../../types';

const context: EvidenceContext = {
  chunkIndex: 0,
  chunkText: 'Segment 1: baterainya habis setelah\nSegment 2: 17 jam 42 menit',
  chunkSegments: [
    { index: 1, start: '00:00:01,000', end: '00:00:02,000', text: 'baterainya habis setelah' },
    { index: 2, start: '00:00:02,000', end: '00:00:03,000', text: '17 jam 42 menit' }
  ]
};

describe('PROVENANCE VALIDATOR', () => {
  test('PASS: single segment', () => {
    const result = ProvenanceValidator.resolve('baterainya habis setelah', null, context);
    expect(result.result.status).toBe('PASS');
    expect(result.coordinates).toEqual({
      chunk_index: 0,
      segment_start_index: 1,
      segment_end_index: 1,
      char_start: null,
      char_end: null
    });
  });

  test('PASS: cross-segment', () => {
    const result = ProvenanceValidator.resolve(
      'baterainya habis setelah 17 jam 42 menit',
      null,
      context
    );
    expect(result.result.status).toBe('PASS');
    expect(result.coordinates).toEqual({
      chunk_index: 0,
      segment_start_index: 1,
      segment_end_index: 2,
      char_start: null,
      char_end: null
    });
  });

  test('FAIL: missing', () => {
    const result = ProvenanceValidator.resolve('tidak ada', null, context);
    expect(result.result.status).toBe('FAIL');
    expect(result.coordinates).toBeNull();
  });

  test('SUSPECT: ambiguous', () => {
    const ambiguousContext: EvidenceContext = {
      chunkIndex: 0,
      chunkText: '6 generasi Android\n6 generasi Android',
      chunkSegments: [
        { index: 1, start: '00:00:01,000', end: '00:00:02,000', text: '6 generasi Android' },
        { index: 2, start: '00:00:02,000', end: '00:00:03,000', text: '6 generasi Android' }
      ]
    };
    const result = ProvenanceValidator.resolve('6 generasi Android', null, ambiguousContext);
    expect(result.result.status).toBe('SUSPECT');
    expect(result.coordinates).toBeNull();
  });
});

const seg2 = (index: number, text: string) => ({
  index, start: '00:00:00,000', end: '00:00:01,000', text
});
const pSegs = [
  seg2(4, 'Yang pertama Samsung Galaxy A07s'),
  seg2(11, 'Layarnya berukuran di 6,7 inci'),
  seg2(25, 'Selanjutnya Samsung Galaxy A18'),
  seg2(34, 'Layarnya juga berukuran di 6,7 inci')
];
const pCtx: EvidenceContext = {
  chunkIndex: 0,
  chunkSegments: pSegs,
  chunkText: pSegs.map(s => s.text).join(' ')
};

describe('PROVENANCE: product-veto', () => {
  test('hint valid → SUSPECT LOW code PRODUCT_VETO, koordinat terisi, non-blocking', () => {
    const r = ProvenanceValidator.resolve('berukuran di 6,7 inci', null, pCtx, {
      productHint: 'Samsung Galaxy A18'
    });
    expect(r.result.status).toBe('SUSPECT');
    expect(r.result.severity).toBe('LOW');
    expect(r.result.code).toBe('PRODUCT_VETO');
    expect(r.result.pass).toBe(true);
    expect(r.coordinates?.segment_start_index).toBe(34);
  });

  test.each([undefined, null, ''])('tanpa hint (%p) → tetap SUSPECT HIGH (excerpt ≥20 char)', productHint => {
    const r = ProvenanceValidator.resolve('berukuran di 6,7 inci', null, pCtx, { productHint });
    expect(r.result.status).toBe('SUSPECT');
    expect(r.result.severity).toBe('HIGH');
    expect(r.coordinates).toBeNull();
  });

  test('hint produk tak dikenal → SUSPECT HIGH', () => {
    const r = ProvenanceValidator.resolve('berukuran di 6,7 inci', null, pCtx, {
      productHint: 'Samsung Galaxy A99'
    });
    expect(r.result.severity).toBe('HIGH');
  });

  test('selectProductHint: claim diutamakan, context sebagai fallback, selain itu null', () => {
    expect(selectProductHint('Galaxy A18 layar 6,7 inci', 'Galaxy A07s')).toBe('Galaxy A18 layar 6,7 inci');
    expect(selectProductHint('Layar 6,7 inci', 'Samsung Galaxy A18')).toBe('Samsung Galaxy A18');
    expect(selectProductHint('Android 16', null)).toBeNull();
    expect(selectProductHint(undefined, undefined)).toBeNull();
  });
});
