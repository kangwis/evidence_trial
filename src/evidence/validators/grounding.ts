// ============================================================
// GROUNDING VALIDATOR — existence + single-SRT enforcement
// ============================================================
// Tanggung jawab:
//   1. Existence: source_excerpt harus ditemukan di originating chunk.
//   2. Single-SRT: excerpt harus berada dalam maksimal 5 segmen SRT
//      berurutan (Opsi A, prompt rule 8 versi baru).
//   3. Quasi-literal: excerpt yang kata bermaknanya ada + urutan asli,
//      dengan perbedaan kata fungsi / imbuhan / ejaan, tetap diterima
//      sebagai PASS + flag QUASI_LITERAL (SUSPECT LOW, non-blocking).
//
// Keberadaan >1 match BUKAN urusan Grounding. Ambiguitas adalah
// domain Provenance.
//
// CHANGELOG:
//   - maxSpan dinaikkan dari 1 ke 3 (Opsi A).
//   - Tier 2 (quasi-literal) ditambahkan sebagai fallback bila exact
//     gagal. PASS + SUSPECT LOW + code QUASI_LITERAL.
//   - Tier 3: FAIL reason diperkaya menyebut kata bermakna spesifik
//     yang tidak ada di chunk (audit lebih cepat).
// ============================================================

import type {
  EvidenceContext,
  ValidationResult
} from '../types';
import {
  MAX_VALIDATION_SPAN,
  findSourceMatches,
  findSourceMatchesQuasi,
  diagnoseQuasiLiteralFailure,
  excerptContainsEllipsis,
  excerptSpansMultipleSegments,
  stripSegmentMarkers
} from '../search';
import { matchQuasiLiteralInSegments, type QuasiLiteralResult } from '../text-matching';
export const GroundingValidator = {
  validate(
    sourceExcerpt: string | null | undefined,
    context: EvidenceContext
  ): ValidationResult {
    // --- Tier 1: exact substring match (maks MAX_VALIDATION_SPAN segmen) ---
    const matches = findSourceMatches(sourceExcerpt, context, {
      maxSpan: MAX_VALIDATION_SPAN
    });

    if (matches.length > 0) {
      return {
        pass: true,
        status: 'PASS',
        rule: 'GROUNDING',
        severity: 'LOW'
      };
    }

    // --- Tier 2: quasi-literal (kata bermakna + urutan asli) ---
    const quasi = findSourceMatchesQuasi(sourceExcerpt, context, {
      maxSpan: MAX_VALIDATION_SPAN
    });
    if (quasi) {
      return {
        pass: true,
        status: 'SUSPECT',
        rule: 'GROUNDING',
        severity: 'LOW',
        code: 'QUASI_LITERAL',
        reason:
          `Quasi-literal: kata bermakna excerpt ada di chunk dalam urutan asli; ` +
          `kata fungsi / imbuhan / ejaan dinormalisasi ` +
          `(coverage ${(quasi.coverage * 100).toFixed(0)}%, span ${quasi.segmentStartIndex}..${quasi.segmentEndIndex}).`
      };
    }

    // Tier 2 gagal. Cek apakah gagal karena span terlalu besar.
    const quasiRaw = matchQuasiLiteralInSegments(stripSegmentMarkers(sourceExcerpt), context.chunkSegments);
    if (quasiRaw.matches && quasiRaw.spanInSegments > MAX_VALIDATION_SPAN) {
       return {
         pass: false, status: 'FAIL', severity: 'CRITICAL', rule: 'GROUNDING',
         reason:
          `Kata bermakna excerpt ada + urutan asli, tetapi melintasi ` +
          `${quasiRaw.spanInSegments} segmen SRT (maksimum ${MAX_VALIDATION_SPAN} menurut prompt rule 8).`
       };
     }

    // --- Tier 3: FAIL dengan reason diperkaya ---
    // Sebelum jatuh ke reason generik, cek apakah kita bisa menyebut
    // kata bermakna spesifik yang hilang. Ini jauh lebih informatif
    // untuk audit manual.
    const diag = diagnoseQuasiLiteralFailure(sourceExcerpt, context);
    if (diag && diag.missingTokens.length > 0) {
      const shown = diag.missingTokens.slice(0, 5).join(', ');
      const more = diag.missingTokens.length > 5
        ? ` (+${diag.missingTokens.length - 5} lagi)`
        : '';
      return {
        pass: false,
        status: 'FAIL',
        rule: 'GROUNDING',
        severity: 'CRITICAL',
        reason:
          `source_excerpt memuat kata bermakna yang tidak ada di originating chunk: ` +
          `${shown}${more}`
      };
    }

    // --- Tier 3 fallback: multi-SRT ---
    if (excerptSpansMultipleSegments(sourceExcerpt, context)) {
      return {
        pass: false,
        status: 'FAIL',
        rule: 'GROUNDING',
        reason:
          `source_excerpt hanya ditemukan saat melintasi lebih dari ${MAX_VALIDATION_SPAN} segmen SRT ` +
          `(maksimum ${MAX_VALIDATION_SPAN} menurut prompt rule 8)`,
        severity: 'CRITICAL'
      };
    }

    // --- Tier 3 fallback: elipsis / not-found ---
    const reason = excerptContainsEllipsis(sourceExcerpt)
      ? 'source_excerpt mengandung elipsis ("..." atau "…") dan tidak ditemukan di originating chunk -- indikasi excerpt bukan kutipan literal berurutan, melainkan rangkuman/gabungan fragmen non-kontinu'
      : 'source_excerpt tidak ditemukan di originating chunk';

    return {
      pass: false,
      status: 'FAIL',
      rule: 'GROUNDING',
      reason,
      severity: 'CRITICAL'
    };
  }
};
