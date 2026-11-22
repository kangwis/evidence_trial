import { describe, test, expect } from 'vitest';
import { pruneDanglingRelatedIds } from '../related-ids';

const ev = (id: string, refs: string[] | null = null) => ({
  evidence_id: id,
  related_evidence_ids: refs
});

describe('pruneDanglingRelatedIds', () => {
  test('referensi ke evidence yang tidak ada dibuang, yang valid dipertahankan', () => {
    const r = pruneDanglingRelatedIds([ev('E001', ['E002', 'E009']), ev('E002')]);
    expect(r.evidence[0].related_evidence_ids).toEqual(['E002']);
    expect(r.dropped).toBe(1);
  });

  test('semua referensi menggantung → null', () => {
    const r = pruneDanglingRelatedIds([ev('E001', ['E009'])]);
    expect(r.evidence[0].related_evidence_ids).toBeNull();
    expect(r.dropped).toBe(1);
  });

  test('self-reference dan duplikat dibuang', () => {
    const r = pruneDanglingRelatedIds([
      ev('E001', ['E001', 'E002', 'E002']),
      ev('E002')
    ]);
    expect(r.evidence[0].related_evidence_ids).toEqual(['E002']);
    expect(r.dropped).toBe(2);
  });

  test('evidence tanpa perubahan dikembalikan sebagai objek yang sama', () => {
    const a = ev('E001', ['E002']);
    const b = ev('E002');
    const c = ev('E003');
    const r = pruneDanglingRelatedIds([a, b, c]);
    expect(r.evidence[0]).toBe(a);
    expect(r.evidence[1]).toBe(b);
    expect(r.evidence[2]).toBe(c);
    expect(r.dropped).toBe(0);
  });

  test('tidak mengarantina / tidak menghapus evidence perujuk', () => {
    const r = pruneDanglingRelatedIds([ev('E001', ['E009']), ev('E002')]);
    expect(r.evidence.map(e => e.evidence_id)).toEqual(['E001', 'E002']);
  });

  test('array kosong dan input kosong aman', () => {
    expect(pruneDanglingRelatedIds([]).evidence).toEqual([]);
    const r = pruneDanglingRelatedIds([ev('E001', [])]);
    expect(r.dropped).toBe(0);
  });
});