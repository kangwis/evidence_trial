import { describe, expect, test } from 'vitest';
import {
  MAX_DIAGNOSTIC_SPAN,
  MAX_VALIDATION_SPAN,
  findSourceMatches
} from '../search';
import type { EvidenceContext } from '../types';

function makeContext(texts: string[]): EvidenceContext {
  return {
    chunkIndex: 0,
    chunkText: texts.join(' '),
    chunkSegments: texts.map((text, i) => ({
      index: i + 1,
      start: `00:00:${String(i).padStart(2, '0')},000`,
      end: `00:00:${String(i + 1).padStart(2, '0')},000`,
      text
    }))
  };
}

const ctx = makeContext(['alpha', 'beta', 'gamma', 'delta', 'tail']);

describe('konstanta span', () => {
  test('batas validasi sesuai prompt rule 8, lebih kecil dari diagnostik', () => {
    expect(MAX_VALIDATION_SPAN).toBe(3);
    expect(MAX_DIAGNOSTIC_SPAN).toBeGreaterThan(MAX_VALIDATION_SPAN);
  });
});

describe('findSourceMatches span limits', () => {
  test('menemukan excerpt yang melintasi tepat 3 segmen', () => {
    expect(findSourceMatches('alpha beta gamma', ctx, { maxSpan: 3 }))
      .toEqual([{ segmentStartIndex: 1, segmentEndIndex: 3 }]);
  });

  test('tidak menemukan excerpt 3 segmen bila batas hanya 2', () => {
    expect(findSourceMatches('alpha beta gamma', ctx, { maxSpan: 2 })).toEqual([]);
  });

  test('default = MAX_VALIDATION_SPAN: 3 segmen ketemu, 4 segmen tidak', () => {
    expect(findSourceMatches('alpha beta gamma', ctx))
      .toEqual([{ segmentStartIndex: 1, segmentEndIndex: 3 }]);
    expect(findSourceMatches('alpha beta gamma delta', ctx)).toEqual([]);
  });

  test('excerpt 4 segmen tetap terdiagnosis pada batas diagnostik', () => {
    expect(
      findSourceMatches('alpha beta gamma delta', ctx, { maxSpan: MAX_DIAGNOSTIC_SPAN })
    ).toEqual([{ segmentStartIndex: 1, segmentEndIndex: 4 }]);
  });

  test('excerpt yang utuh dalam 1 segmen tidak dilaporkan sebagai span lebih lebar', () => {
    expect(findSourceMatches('beta', ctx, { maxSpan: 3 }))
      .toEqual([{ segmentStartIndex: 2, segmentEndIndex: 2 }]);
  });
});