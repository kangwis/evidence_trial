import { describe, test, expect } from 'vitest';
import { parseEvidenceJSONDetailed } from '../production-pipeline';
import { buildChunkLocalKeys, remapRelatedIds } from '../related-ids';

// ============================================================
// GAP 1: ambiguousIds — duplikat model-model & collision
// ============================================================
describe('ambiguousIds: duplikat dan collision', () => {
  test('dua item model dengan ID sama → masuk ambiguousIds', () => {
    const raw = JSON.stringify([
      { evidence_id: 'E001', claim: 'A' },
      { evidence_id: 'E001', claim: 'B' }
    ]);
    const r = parseEvidenceJSONDetailed(raw);
    const { diagnostics } = buildChunkLocalKeys(r.evidence, 0, r.idMetadata);

    expect(diagnostics.duplicateIds).toContain('E001');
    expect(diagnostics.ambiguousIds).toContain('E001');  // ← Patch B
  });

  test('auto-fill + model collision → masuk ambiguousIds', () => {
    const raw = JSON.stringify([
      { claim: 'A' },                       // auto-fill E001
      { evidence_id: 'E001', claim: 'B' }   // model E001 → collision
    ]);
    const r = parseEvidenceJSONDetailed(raw);
    const { diagnostics } = buildChunkLocalKeys(r.evidence, 0, r.idMetadata);

    expect(diagnostics.reason).toBe('auto-fill-collision');
    expect(diagnostics.ambiguousIds).toContain('E001');
  });

  test('reference ke ambiguous → droppedAmbiguous', () => {
    const raw = JSON.stringify([
      { evidence_id: 'E001', claim: 'A', related_evidence_ids: ['E001'] },
      { evidence_id: 'E001', claim: 'B' }
    ]);
    const r = parseEvidenceJSONDetailed(raw);
    const { keys, diagnostics } = buildChunkLocalKeys(r.evidence, 0, r.idMetadata);
    const { stats } = remapRelatedIds(r.evidence, keys, [diagnostics]);

    expect(stats.droppedAmbiguous).toBeGreaterThanOrEqual(1);
    expect(stats.mapped).toBe(0);
  });
});

// ============================================================
// GAP 2: outOfOrderPositions
// ============================================================
describe('outOfOrderPositions', () => {
  test('ID unik out-of-order → dicatat di posisi yang salah', () => {
    const raw = JSON.stringify([
      { evidence_id: 'E002', claim: 'A' },
      { evidence_id: 'E001', claim: 'B' },
      { evidence_id: 'E003', claim: 'C' }
    ]);
    const r = parseEvidenceJSONDetailed(raw);
    const { diagnostics } = buildChunkLocalKeys(r.evidence, 0, r.idMetadata);

    expect(diagnostics.mode).toBe('llm-ids');  // tetap llm-ids
    expect(diagnostics.outOfOrderPositions).toEqual([1, 2]);
  });

  test('ID sesuai urutan → outOfOrderPositions kosong', () => {
    const raw = JSON.stringify([
      { evidence_id: 'E001', claim: 'A' },
      { evidence_id: 'E002', claim: 'B' }
    ]);
    const r = parseEvidenceJSONDetailed(raw);
    const { diagnostics } = buildChunkLocalKeys(r.evidence, 0, r.idMetadata);
    expect(diagnostics.outOfOrderPositions).toEqual([]);
  });

  test('auto-fill tidak dihitung out-of-order', () => {
    const raw = JSON.stringify([
      { claim: 'A' },                         // auto-fill
      { evidence_id: 'E002', claim: 'B' }     // model, posisi 2
    ]);
    const r = parseEvidenceJSONDetailed(raw);
    const { diagnostics } = buildChunkLocalKeys(r.evidence, 0, r.idMetadata);
    expect(diagnostics.outOfOrderPositions).toEqual([]);
  });

  test('ID duplikat tidak masuk out-of-order (sudah ambiguous)', () => {
    const raw = JSON.stringify([
      { evidence_id: 'E002', claim: 'A' },
      { evidence_id: 'E002', claim: 'B' }
    ]);
    const r = parseEvidenceJSONDetailed(raw);
    const { diagnostics } = buildChunkLocalKeys(r.evidence, 0, r.idMetadata);
    // Duplikat ditangani lewat ambiguousIds, bukan out-of-order
    expect(diagnostics.outOfOrderPositions).toEqual([]);
  });
});

// ============================================================
// GAP 3: source = 'invalid'
// ============================================================
describe('source: "invalid" untuk item bukan objek', () => {
  test('string dalam array evidence → source="invalid"', () => {
    const raw = JSON.stringify([
      { evidence_id: 'E001', claim: 'A' },
      "not an object",
      { evidence_id: 'E003', claim: 'C' }
    ]);
    const r = parseEvidenceJSONDetailed(raw);
    expect(r.idMetadata[0].source).toBe('model');
    expect(r.idMetadata[1].source).toBe('invalid');
    expect(r.idMetadata[1].originalId).toBeNull();
    expect(r.idMetadata[2].source).toBe('model');
  });

  test('autoFilledCount TIDAK menghitung item invalid', () => {
    const raw = JSON.stringify([
      { claim: 'A' },       // auto-fill
      "invalid",            // invalid (tidak boleh dihitung)
      { claim: 'C' }        // auto-fill
    ]);
    const r = parseEvidenceJSONDetailed(raw);
    const { diagnostics } = buildChunkLocalKeys(r.evidence, 0, r.idMetadata);
    expect(diagnostics.autoFilledCount).toBe(2);  // bukan 3
    expect(diagnostics.modelProvidedCount).toBe(0);
  });
});

// ============================================================
// GAP 4: ambiguous check SEBELUM self-ref
// ============================================================
describe('urutan check: ambiguous sebelum self-reference', () => {
  test('reference ke localId sendiri saat ID ambiguous → droppedAmbiguous (bukan droppedSelf)', () => {
    const raw = JSON.stringify([
      { evidence_id: 'E001', claim: 'A', related_evidence_ids: ['E001'] },
      { evidence_id: 'E001', claim: 'B' }
    ]);
    const r = parseEvidenceJSONDetailed(raw);
    const { keys, diagnostics } = buildChunkLocalKeys(r.evidence, 0, r.idMetadata);
    const { stats } = remapRelatedIds(r.evidence, keys, [diagnostics]);

    // Tanpa Patch C: droppedSelf=1, droppedAmbiguous=0
    // Dengan Patch C: droppedSelf=0, droppedAmbiguous>=1
    expect(stats.droppedSelf).toBe(0);
    expect(stats.droppedAmbiguous).toBeGreaterThanOrEqual(1);
  });
});