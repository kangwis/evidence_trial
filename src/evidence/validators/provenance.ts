// ============================================================
// PROVENANCE VALIDATOR
// ============================================================
// Tanggung jawab:
//   1. Existence (via findSourceMatches, maxSpan=5) → FAIL jika 0.
//   2. Single-SRT: excerpt harus berada dalam diperbarui ke 3.
//   3. Quasi-literal fallback: bila exact gagal tapi kata bermakna
//      + urutan asli terpenuhi → PASS + SUSPECT LOW + code QUASI_LITERAL.
//   4. Occurrence disambiguation (exact match only) via
//      resolveProvenanceAnchor() → RESOLVED / AMBIGUOUS.
//
// Resolver internal sengaja TIDAK menangani FAIL — status-nya
// hanya RESOLVED | AMBIGUOUS (dikunci audit Ronde 3). FAIL
// dibangun di sini dari sinyal existence.
//
// CHANGELOG (ronde terbaru):
//   - diperbarui ke 3.
//   - Tier 2 quasi-literal ditambahkan. Koordinat diambil langsung
//     dari span quasi-match (resolver TIDAK dipanggil karena
//     resolver butuh exact match).
//   - Tier 3: FAIL reason diperkaya dengan kata bermakna yang hilang.
// ============================================================

import type {
  EvidenceContext,
  SourceCoordinates,
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
import { resolveProvenanceAnchor } from './anchor-resolver';
export { selectProductHint } from './anchor-resolver';
import { matchQuasiLiteralInSegments } from '../text-matching';

export interface ProvenanceResolverOptions {
  /** Hint produk (dari claim/context) untuk fase 3 resolver. null → skip. */
  productHint?: string | null;
}

export const ProvenanceValidator = {
  resolve(
    sourceExcerpt: string | null | undefined,
    anchor: string | null | undefined,
    context: EvidenceContext,
    options: ProvenanceResolverOptions = {}
  ): {
    coordinates: SourceCoordinates | null;
    result: ValidationResult;
  } {
    // --- Tier 1: exact substring match (Opsi A, maxSpan=5) ---
    const matches = findSourceMatches(sourceExcerpt, context, {
      maxSpan: MAX_VALIDATION_SPAN
    });

    if (matches.length === 0) {
      // --- Tier 2: quasi-literal ---
      const quasi = findSourceMatchesQuasi(sourceExcerpt, context, {
        maxSpan: MAX_VALIDATION_SPAN
      });
      if (quasi) {
        // Quasi-literal: resolver anchor tidak bisa dipakai
        // (butuh exact match untuk disambiguasi). Koordinat diambil
        // dari span hasil quasi-match. Risk ambiguitas diabaikan
        // karena status-nya sudah SUSPECT LOW + flag — konsumen
        // downstream bisa melihatnya dan meninjau manual.
        return {
          coordinates: {
            chunk_index: context.chunkIndex,
            segment_start_index: quasi.segmentStartIndex,
            segment_end_index: quasi.segmentEndIndex,
            char_start: null,
            char_end: null
          },
          result: {
            pass: true,
            status: 'SUSPECT',
            rule: 'PROVENANCE',
            severity: 'LOW',
            code: 'QUASI_LITERAL',
            reason:
              `Quasi-literal: excerpt traceable ke segmen ${quasi.segmentStartIndex}..${quasi.segmentEndIndex} ` +
              `setelah normalisasi kata fungsi / imbuhan / ejaan ` +
              `(coverage ${(quasi.coverage * 100).toFixed(0)}%).`
          }
        };
      }

      // Tier 2 gagal. Cek apakah gagal karena span terlalu besar.
      const quasiRaw = matchQuasiLiteralInSegments(
        stripSegmentMarkers(sourceExcerpt),
        context.chunkSegments
      );
      if (quasiRaw.matches && quasiRaw.spanInSegments > MAX_VALIDATION_SPAN) {
        return {
          coordinates: null,
          result: {
            pass: false,
            status: 'FAIL',
            severity: 'CRITICAL',
            rule: 'PROVENANCE',
            reason:
              `Kata bermakna excerpt ada + urutan asli, tetapi melintasi ` +
              `${quasiRaw.spanInSegments} segmen SRT (maksimum ${MAX_VALIDATION_SPAN} menurut prompt rule 8).`
          }
        };
      }

      // --- Tier 3: FAIL dengan reason diperkaya ---
      const diag = diagnoseQuasiLiteralFailure(sourceExcerpt, context);
      if (diag && diag.missingTokens.length > 0) {
        const shown = diag.missingTokens.slice(0, 5).join(', ');
        const more = diag.missingTokens.length > 5
          ? ` (+${diag.missingTokens.length - 5} lagi)`
          : '';
        return {
          coordinates: null,
          result: {
            pass: false,
            status: 'FAIL',
            rule: 'PROVENANCE',
            severity: 'CRITICAL',
            reason:
              `source_excerpt memuat kata bermakna yang tidak ada di originating chunk: ` +
              `${shown}${more}`
          }
        };
      }

      // --- Tier 3 fallback: multi-SRT ---
      if (excerptSpansMultipleSegments(sourceExcerpt, context)) {
        return {
          coordinates: null,
          result: {
            pass: false,
            status: 'FAIL',
            rule: 'PROVENANCE',
            reason:
              `source_excerpt hanya ditemukan saat melintasi lebih dari ${MAX_VALIDATION_SPAN} segmen SRT ` +
              `(maksimum ${MAX_VALIDATION_SPAN} menurut prompt rule 8)`,
            severity: 'CRITICAL'
          }
        };
      }

      // --- Tier 3 fallback: elipsis / not-found ---
      const reason = excerptContainsEllipsis(sourceExcerpt)
        ? 'source_excerpt mengandung elipsis ("..." atau "…") dan tidak ditemukan di originating chunk -- indikasi excerpt bukan kutipan literal berurutan, melainkan rangkuman/gabungan fragmen non-kontinu'
        : 'source_excerpt tidak ditemukan di originating chunk';

      return {
        coordinates: null,
        result: {
          pass: false,
          status: 'FAIL',
          rule: 'PROVENANCE',
          reason,
          severity: 'CRITICAL'
        }
      };
    }

    // --- Exact match ditemukan → occurrence disambiguation (existing) ---
    const resolution = resolveProvenanceAnchor(
      sourceExcerpt,
      anchor,
      context,
      { productHint: options.productHint }
    );

    if (resolution.status === 'AMBIGUOUS') {
      // N8: Excerpt pendek (<20 karakter) → MEDIUM (non-block).
      // Excerpt panjang yang ambigu → HIGH (block).
      const isShortExcerpt = (sourceExcerpt || '').length < 20;
      const severity: 'HIGH' | 'MEDIUM' = isShortExcerpt ? 'MEDIUM' : 'HIGH';
      const pass = severity === 'MEDIUM';

      return {
        coordinates: null,
        result: {
          pass,
          status: 'SUSPECT',
          rule: 'PROVENANCE',
          reason: 'source_excerpt ambiguous, lebih dari satu kemungkinan occurrence',
          severity
        }
      };
    }

    // --- RESOLVED (exact match, unambiguous) ---
    // (maxSpan=3).
    // Resolusi lewat produk bergantung pada klaim model → SUSPECT LOW
    // (non-blocking, tapi terhitung di accepted_flagged dan terlihat di replay).
    if (resolution.via === 'product') {
      return {
        coordinates: resolution.coordinates,
        result: {
          pass: true,
          status: 'SUSPECT',
          rule: 'PROVENANCE',
          severity: 'LOW',
          code: 'PRODUCT_VETO',
          reason:
            'Occurrence ditentukan lewat produk pada klaim (anchor tidak diskriminatif); ' +
            'koordinat bergantung pada klaim model.'
        }
      };
    }
    return {
      coordinates: resolution.coordinates,
      result: {
        pass: true,
        status: 'PASS',
        rule: 'PROVENANCE',
        severity: 'LOW'
      }
    };
  }
};
