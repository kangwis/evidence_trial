import { describe, test, expect } from 'vitest';
import { resolveDuplicateActions } from '../../../server';
import type { DuplicateResult } from '../validators/duplicate';
import type { EvidenceItem } from '../types';

const ev = (id: string): EvidenceItem => ({ evidence_id: id, claim: `klaim ${id}` });

const result = (keptId: string | undefined): DuplicateResult => ({
  candidates: [],
  duplicatePairs: [{
    evidence_id_a: 'E001',
    evidence_id_b: 'E002',
    action: 'KEEP_FIRST',
    reason: 'test',
    keptId
  }]
});

describe('resolveDuplicateActions: validasi keptId', () => {
  test('keptId di luar pasangan → fail-closed, tidak ada yang dihapus', () => {
    const out = resolveDuplicateActions([ev('E001'), ev('E002')], result('E999'), []);
    expect(out.preservedEvidence.map(e => e.evidence_id)).toEqual(['E001', 'E002']);
    expect(out.duplicateRemovedDetails).toHaveLength(0);
  });

  test('keptId kosong → fail-closed', () => {
    const out = resolveDuplicateActions([ev('E001'), ev('E002')], result(undefined), []);
    expect(out.preservedEvidence).toHaveLength(2);
    expect(out.duplicateRemovedDetails).toHaveLength(0);
  });

  test('kontrol: keptId = A → B dihapus', () => {
    const out = resolveDuplicateActions([ev('E001'), ev('E002')], result('E001'), []);
    expect(out.preservedEvidence.map(e => e.evidence_id)).toEqual(['E001']);
    expect(out.duplicateRemovedDetails[0]).toMatchObject({
      evidence_id: 'E002',
      kept_evidence_id: 'E001'
    });
  });

  test('kontrol: keptId = B → A dihapus', () => {
    const out = resolveDuplicateActions([ev('E001'), ev('E002')], result('E002'), []);
    expect(out.preservedEvidence.map(e => e.evidence_id)).toEqual(['E002']);
    expect(out.duplicateRemovedDetails[0].evidence_id).toBe('E001');
  });
});
