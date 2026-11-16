// ============================================================
// TIMESTAMP VALIDATOR — POST-PROCESS (defense-in-depth)
// ============================================================
// BUKAN bagian dari EvidenceValidator.validate() karena timestamp
// baru di-generate setelah semua validator lain selesai (lihat
// server.ts extractEvidence). Validator ini dijalankan sebagai
// post-process, setelah getTimestampFromCoordinates.
//
// Tujuan: menutup gap "timestamp tidak divalidasi di manapun".
// Kasus E149 (segment_start_index=260 tapi timestamp_start milik
// segmen 259) TIDAK terdeteksi oleh 5 validator lain karena mereka
// tidak menerima timestamp sebagai input.
//
// Invariant yang ditegakkan:
//   1. source_coordinates null <=> timestamp_start/end null.
//   2. source_coordinates.segment_start_index <= segment_end_index.
//   3. Segment yang ditunjuk source_coordinates ADA di SRT.
//   4. timestamp_start === segments[segment_start_index].start.
//   5. timestamp_end   === segments[segment_end_index].end.
//
// Tidak ada auto-correct. Evidence yang melanggar invariant masuk
// quarantine via server.ts, bukan diperbaiki diam-diam.
// ============================================================

import type { EvidenceItem, ValidationResult } from '../types';
import type { SRTSegment } from '../srt';

export const TimestampValidator = {
  validate(
    evidence: EvidenceItem,
    allSegments: SRTSegment[]
  ): ValidationResult {
    const coords = evidence.source_coordinates;
    const tsStart = evidence.timestamp_start ?? null;
    const tsEnd = evidence.timestamp_end ?? null;

    // ── Case 1: tidak ada source_coordinates ─────────────────────
    // Timestamp WAJIB null. Timestamp tanpa koordinat = orphan.
    if (!coords) {
      if (tsStart || tsEnd) {
        return {
          pass: false,
          status: 'FAIL',
          rule: 'TIMESTAMP',
          reason:
            'timestamp_start/timestamp_end terisi tanpa source_coordinates ' +
            '-- orphan timestamp, tidak bisa diverifikasi terhadap SRT',
          severity: 'HIGH'
        };
      }
      return {
        pass: true,
        status: 'PASS',
        rule: 'TIMESTAMP',
        severity: 'LOW'
      };
    }

    // ── Case 2: source_coordinates ada, timestamp hilang ─────────
    if (!tsStart || !tsEnd) {
      return {
        pass: false,
        status: 'FAIL',
        rule: 'TIMESTAMP',
        reason:
          `source_coordinates ada (segment ${coords.segment_start_index}` +
          `..${coords.segment_end_index}) tetapi timestamp_start/timestamp_end null`,
        severity: 'HIGH'
      };
    }

    // ── Case 3: urutan index salah ───────────────────────────────
    if (coords.segment_start_index > coords.segment_end_index) {
      return {
        pass: false,
        status: 'FAIL',
        rule: 'TIMESTAMP',
        reason:
          `segment_start_index (${coords.segment_start_index}) > ` +
          `segment_end_index (${coords.segment_end_index})`,
        severity: 'HIGH'
      };
    }

    // ── Case 4: segmen tidak ditemukan di SRT ────────────────────
    const startSegment = allSegments.find(
      s => s.index === coords.segment_start_index
    );
    const endSegment = allSegments.find(
      s => s.index === coords.segment_end_index
    );

    if (!startSegment || !endSegment) {
      const missing: string[] = [];
      if (!startSegment) missing.push(String(coords.segment_start_index));
      if (!endSegment) missing.push(String(coords.segment_end_index));
      return {
        pass: false,
        status: 'FAIL',
        rule: 'TIMESTAMP',
        reason:
          `source_coordinates menunjuk segment yang tidak ada di SRT: ` +
          missing.join(', '),
        severity: 'HIGH'
      };
    }

    // ── Case 5: timestamp_start tidak cocok ─────────────────────
    if (tsStart !== startSegment.start) {
      return {
        pass: false,
        status: 'FAIL',
        rule: 'TIMESTAMP',
        reason:
          `timestamp_start ("${tsStart}") tidak cocok dengan segment ` +
          `${coords.segment_start_index} (start="${startSegment.start}")`,
        severity: 'HIGH'
      };
    }

    // ── Case 6: timestamp_end tidak cocok ────────────────────────
    if (tsEnd !== endSegment.end) {
      return {
        pass: false,
        status: 'FAIL',
        rule: 'TIMESTAMP',
        reason:
          `timestamp_end ("${tsEnd}") tidak cocok dengan segment ` +
          `${coords.segment_end_index} (end="${endSegment.end}")`,
        severity: 'HIGH'
      };
    }

    return {
      pass: true,
      status: 'PASS',
      rule: 'TIMESTAMP',
      severity: 'LOW'
    };
  }
};