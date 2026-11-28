import { describe, test, expect } from 'vitest';
import { EvidenceValidator } from '../evidence-validator';
import type { EvidenceContext, EvidenceItem } from '../../types';

const seg = (index: number, text: string) => ({
  index, start: '00:00:00,000', end: '00:00:01,000', text
});

const allSegs = [
  seg(4, 'Nah, yang pertama di Samsung Galaxy A07s.'),
  seg(11, 'Layarnya PLS LCD berukuran'),
  seg(12, 'di 6,7 inci,'),
  seg(25, 'Samsung Galaxy A18.'),
  seg(34, 'Oktober 2026, layarnya Super AMOLED berukuran di 6,7 inci, layarnya sudah Full HD+, di mana'),
  seg(38, 'pengisian fast charging di 25 Watt. Oke, kita berlanjut ke Samsung Galaxy A08. Ini lagi'),
  seg(42, 'Layarnya PLS LCD berukuran di 6,7 inci, sistem operasinya menggunakan Android 17 dan')
];
const chunkOnly = allSegs.filter(s => [11, 12, 34, 42].includes(s.index)); // tanpa mention produk

const ctx = (withAll: boolean): EvidenceContext => ({
  chunkIndex: 0,
  chunkSegments: chunkOnly,
  chunkText: chunkOnly.map(s => s.text).join(' '),
  allSegments: withAll ? allSegs : undefined
});

const ev = (claim: string, context: string | null = null): EvidenceItem => ({
  type: 'FACT',
  topic: 'display',
  subtopic: '6,7-inci',
  claim,
  context,
  source_excerpt: 'berukuran di 6,7 inci',
  reviewer_assessment: null
});

describe('PRODUCT-VETO end-to-end (EvidenceValidator)', () => {
  test('ANCHOR_ECHO + claim memuat produk + mention di luar chunk (allSegments) → diterima, koordinat seg 34', () => {
    const e = ev('Samsung Galaxy A18 memiliki layar berukuran 6,7 inci');
    const report = EvidenceValidator.validate(e, ctx(true));
    expect(report.accepted).toBe(true);
    expect(e.source_coordinates?.segment_start_index).toBe(34);
    const p = report.results.find(r => r.rule === 'PROVENANCE');
    expect(p?.code).toBe('PRODUCT_VETO');
    expect(report.finalStatus).toBe('VALID'); // SUSPECT LOW tidak menurunkan status
  });

  test('tanpa allSegments, mention tidak ada di chunk → fail-closed QUARANTINE', () => {
    const e = ev('Samsung Galaxy A18 memiliki layar berukuran 6,7 inci');
    const report = EvidenceValidator.validate(e, ctx(false));
    expect(report.accepted).toBe(false);
    expect(report.quarantineReason).toContain('SUSPECT HIGH');
    expect(e.source_coordinates).toBeNull();
  });

  test('claim tanpa produk (pola c5#6) → QUARANTINE', () => {
    const e = ev('Layar berukuran 6,7 inci');
    const report = EvidenceValidator.validate(e, ctx(true));
    expect(report.accepted).toBe(false);
  });

  test('produk hanya di evidence.context → dipakai sebagai fallback hint', () => {
    const e = ev('Layar berukuran 6,7 inci', 'Samsung Galaxy A08');
    const report = EvidenceValidator.validate(e, ctx(true));
    expect(report.accepted).toBe(true);
    expect(e.source_coordinates?.segment_start_index).toBe(42);
  });
});