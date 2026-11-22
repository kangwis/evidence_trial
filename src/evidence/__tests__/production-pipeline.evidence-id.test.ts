
import { describe, test, expect } from 'vitest';
import { parseEvidenceJSON } from '../production-pipeline';

describe('PRODUCTION PIPELINE: evidence_id auto-fill', () => {
  test('PASS: semua ID kosong diisi mengikuti posisi array', () => {
    const raw = JSON.stringify({
      evidence: [
        { claim: 'Fakta pertama' },
        { claim: 'Fakta kedua' },
        { claim: 'Fakta ketiga' }
      ]
    });

    const result = parseEvidenceJSON(raw);

    expect(result.map(e => e.evidence_id)).toEqual([
      'E001',
      'E002',
      'E003'
    ]);
  });

  test('PASS: ID yang sudah tersedia dipertahankan', () => {
    const raw = JSON.stringify({
      evidence: [
        { evidence_id: 'E001', claim: 'Fakta pertama' },
        { evidence_id: 'E002', claim: 'Fakta kedua' }
      ]
    });

    const result = parseEvidenceJSON(raw);

    expect(result.map(e => e.evidence_id)).toEqual([
      'E001',
      'E002'
    ]);
  });

  test('PASS: ID kosong di tengah diisi berdasarkan posisi', () => {
    const raw = JSON.stringify({
      evidence: [
        { evidence_id: 'E001', claim: 'Fakta pertama' },
        { evidence_id: '', claim: 'Fakta kedua' },
        { evidence_id: 'E003', claim: 'Fakta ketiga' }
      ]
    });

    const result = parseEvidenceJSON(raw);

    expect(result.map(e => e.evidence_id)).toEqual([
      'E001',
      'E002',
      'E003'
    ]);
  });

  test('AUDIT: ID eksplisit tidak ditimpa meskipun urutannya tidak sesuai posisi', () => {
    const raw = JSON.stringify({
      evidence: [
        { evidence_id: 'E003', claim: 'Fakta pertama' },
        { evidence_id: 'E001', claim: 'Fakta kedua' }
      ]
    });

    const result = parseEvidenceJSON(raw);

    expect(result.map(e => e.evidence_id)).toEqual([
      'E003',
      'E001'
    ]);
  });

  test('AUDIT: auto-fill dapat bertabrakan dengan ID eksplisit', () => {
    const raw = JSON.stringify({
      evidence: [
        { evidence_id: '', claim: 'Fakta pertama' },
        { evidence_id: 'E001', claim: 'Fakta kedua' }
      ]
    });

    const result = parseEvidenceJSON(raw);

    // Mengunci perilaku aktual sebelum Patch 1.
    // Kasus ini menunjukkan potensi collision yang harus ditangani.
    expect(result.map(e => e.evidence_id)).toEqual([
      'E001',
      'E001'
    ]);
  });

  test('PASS: nilai evidence_id berupa whitespace diisi berdasarkan posisi', () => {
    const raw = JSON.stringify({
      evidence: [
        { evidence_id: '   ', claim: 'Fakta pertama' },
        { evidence_id: 'E002', claim: 'Fakta kedua' }
      ]
    });

    const result = parseEvidenceJSON(raw);

    expect(result.map(e => e.evidence_id)).toEqual([
      'E001',
      'E002'
    ]);
  });
});
