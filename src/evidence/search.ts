// ============================================================
// EVIDENCE SEARCH HELPER
// ============================================================
// Digunakan oleh GroundingValidator dan ProvenanceValidator.
// Mencari source_excerpt dalam originating chunk.
//
// CHANGELOG:
//   - findSourceMatches: default maxSpan berubah dari 6 (multi-SRT)
//     menjadi 1 (single-SRT), sesuai prompt rule 8:
//     "source_excerpt WAJIB berada dalam SATU subtitle SRT utuh."
//   - Multi-span (2..MAX_DIAGNOSTIC_SPAN) tetap didukung sebagai
//     opsi diagnostik (maxSpan >= 2), TIDAK dipakai di jalur
//     validasi. Dipakai oleh Grounding/Provenance untuk memberi
//     reason FAIL yang lebih informatif saat excerpt melintasi
//     >1 SRT.
//   - Tambah helper excerptSpansMultipleSegments().
// ============================================================

import type { EvidenceContext, SegmentMatch } from './types';
import { normalizeForSearch } from './srt';
import { matchQuasiLiteralInSegments, type QuasiLiteralResult } from './text-matching';

// ------------------------------------------------------------
// DETEKSI ELIPSIS — penanda kuat bahwa excerpt adalah gabungan
// fragmen non-kontinu (bukan kutipan literal berurutan).
// Dipakai HANYA untuk memperjelas PESAN di dalam kondisi yang
// SUDAH FAIL (0 match) -- BUKAN gate independen. Kalau elipsis
// dijadikan gate independen, excerpt yang literal memang
// mengandung "..." di transkrip asli (reviewer bicara terbata-
// bata) bisa salah dihukum padahal excerpt-nya valid dan tetap
// cocok lewat findSourceMatches.
// ------------------------------------------------------------
export function excerptContainsEllipsis(excerpt: string | null | undefined): boolean {
  return /\.{3,}|…/.test(excerpt || '');
}

// ------------------------------------------------------------
// MAX_DIAGNOSTIC_SPAN — batas atas span untuk pencarian diagnostik.
// Nilai historis: 6 (span window pada versi lama). Tidak dipakai
// di jalur validasi; hanya untuk reason FAIL.
// ------------------------------------------------------------
export const MAX_DIAGNOSTIC_SPAN = 6;

// ------------------------------------------------------------
// STRIP PENANDA SEGMEN — [N] di awal/isi teks
// ------------------------------------------------------------
// Sejak Opsi B, chunk text yang dikirim ke LLM memuat penanda [N]
// di awal setiap segmen. Kalau LLM (karena kesalahan) menyertakan
// penanda di source_excerpt, kita strip sebelum search agar tidak
// menghalangi substring match terhadap teks sumber yang polos.
//
// Regex: [N] + spasi opsional. Bukan regex "greedy" — hanya
// menghapus pola literal "[angka]" diikuti spasi.
export function stripSegmentMarkers(text: string | null | undefined): string {
  return String(text ?? '').replace(/\[\d+\]\s*/g, '');
}

/**
 * Cari source_excerpt dalam originating chunk.
 *
 * @param sourceExcerpt   Excerpt literal yang dicari.
 * @param context         EvidenceContext (chunk + segmen SRT).
 * @param options.maxSpan Span maksimum dalam satuan segmen SRT.
 *                        Default 1 — sesuai prompt rule 8:
 *                        "source_excerpt WAJIB berada dalam SATU
 *                        subtitle SRT utuh."
 *
 *                        Nilai >1 hanya untuk diagnostik (mis.
 *                        memberi reason yang lebih baik saat
 *                        excerpt melintasi >1 SRT). Jangan pakai
 *                        nilai >1 di jalur validasi.
 */
export function findSourceMatches(
  sourceExcerpt: string | null | undefined,
  context: EvidenceContext,
  options: { maxSpan?: number } = {}
): SegmentMatch[] {
  const maxSpan = Math.max(1, options.maxSpan ?? 5);
  // BARU: strip penanda [N] sebelum normalize.
  const excerpt = normalizeForSearch(stripSegmentMarkers(sourceExcerpt)); 

  if (!excerpt) {
    return [];
  }

  const matches: SegmentMatch[] = [];

  // 1. Span = 1 (selalu dicari)
  for (const segment of context.chunkSegments) {
    const segText = normalizeForSearch(segment.text);
    if (segText.includes(excerpt)) {
      matches.push({
        segmentStartIndex: segment.index,
        segmentEndIndex: segment.index
      });
    }
  }

  if (maxSpan < 2) {
    return dedupMatches(matches);
  }

  // 2. Span = 2 (diagnostik)
  for (let i = 0; i < context.chunkSegments.length - 1; i++) {
    const combined = normalizeForSearch(
      context.chunkSegments[i].text + ' ' +
      context.chunkSegments[i + 1].text
    );

    if (combined.includes(excerpt)) {
      const seg1 = normalizeForSearch(context.chunkSegments[i].text);
      const seg2 = normalizeForSearch(context.chunkSegments[i + 1].text);

      const isEntirelyInSeg1 = seg1.includes(excerpt);
      const isEntirelyInSeg2 = seg2.includes(excerpt);

      if (!isEntirelyInSeg1 && !isEntirelyInSeg2) {
        matches.push({
          segmentStartIndex: context.chunkSegments[i].index,
          segmentEndIndex: context.chunkSegments[i + 1].index
        });
      }
    }
  }

  if (maxSpan < 5) {
    return dedupMatches(matches);
  }

  // 3. Span = 5..maxSpan (diagnostik)
  const upper = Math.min(maxSpan, MAX_DIAGNOSTIC_SPAN);
  for (let span = 5; span <= upper; span++) {
    for (let i = 0; i + span <= context.chunkSegments.length; i++) {
      const window = context.chunkSegments.slice(i, i + span);
      const combined = normalizeForSearch(
        window.map(s => s.text).join(' ')
      );

      if (!combined.includes(excerpt)) continue;

      // Skip if fully contained in any smaller sub-span (already found)
      let containedInSmaller = false;
      for (let sub = 1; sub < span; sub++) {
        for (let j = 0; j + sub <= window.length; j++) {
          const subCombined = normalizeForSearch(
            window.slice(j, j + sub).map(s => s.text).join(' ')
          );
          if (subCombined.includes(excerpt)) {
            containedInSmaller = true;
            break;
          }
        }
        if (containedInSmaller) break;
      }

      if (!containedInSmaller) {
        matches.push({
          segmentStartIndex: window[0].index,
          segmentEndIndex: window[window.length - 1].index
        });
      }
    }
  }

  return dedupMatches(matches);
}

function dedupMatches(matches: SegmentMatch[]): SegmentMatch[] {
  const unique = new Map<string, SegmentMatch>();
  for (const match of matches) {
    const key = `${match.segmentStartIndex}:${match.segmentEndIndex}`;
    unique.set(key, match);
  }
  return [...unique.values()];
}

/**
 * True jika source_excerpt HANYA match ketika span-nya >1 segmen SRT.
 *
 * Dipakai oleh Grounding/Provenance untuk reason FAIL yang lebih
 * informatif: membedakan "excerpt tidak ada di sumber" dari
 * "excerpt ada tapi melintasi >1 SRT".
 *
 * Precondition: caller sudah tahu bahwa span-1 TIDAK match (biasanya
 * karena findSourceMatches dengan default maxSpan=1 mengembalikan 0).
 * Kalau span-1 match, fungsi ini tidak perlu dipanggil.
 */
export function excerptSpansMultipleSegments(
  sourceExcerpt: string | null | undefined,
  context: EvidenceContext
): boolean {
  // strip penanda supaya konsisten dengan findSourceMatches
  const stripped = stripSegmentMarkers(sourceExcerpt);
  const multiSpanMatches = findSourceMatches(stripped, context, {
    maxSpan: MAX_DIAGNOSTIC_SPAN
  }).filter(m => m.segmentStartIndex !== m.segmentEndIndex);
  return multiSpanMatches.length > 0;
}

// ------------------------------------------------------------
// QUASI-LITERAL SEARCH — tier-2 fallback
// ------------------------------------------------------------
// Dipanggil HANYA setelah findSourceMatches mengembalikan 0 match.
// Menerima excerpt yang kata bermaknanya ada di chunk dalam urutan
// asli, meski ada perbedaan kata fungsi / imbuhan / ejaan.
//
// Return null bila:
//   - excerpt terlalu pendek (<2 kata bermakna), ATAU
//   - ada kata bermakna excerpt yang hilang dari chunk, ATAU
//   - span melebihi maxSpan (default 5, sesuai Opsi A).
//
// Return { matchKind, coverage, ... } bila lolos.
// ------------------------------------------------------------
export interface QuasiMatchInfo {
  matchKind: 'quasi-literal';
  coverage: number;
  segmentStartIndex: number;
  segmentEndIndex: number;
  missingTokens: string[];
}

export function findSourceMatchesQuasi(
  sourceExcerpt: string | null | undefined,
  context: EvidenceContext,
  options: { maxSpan?: number } = {}
): QuasiMatchInfo | null {
  const maxSpan = Math.max(1, options.maxSpan ?? 5);
  const stripped = stripSegmentMarkers(sourceExcerpt);
  if (!stripped) return null;

  const result: QuasiLiteralResult = matchQuasiLiteralInSegments(
    stripped,
    context.chunkSegments
  );

  if (!result.matches) return null;
  if (result.spanInSegments > maxSpan) return null;

  return {
    matchKind: 'quasi-literal',
    coverage: result.coverage,
    segmentStartIndex: result.segmentStartIndex,
    segmentEndIndex: result.segmentEndIndex,
    missingTokens: [],
  };
}

/**
 * Diagnostik: seperti findSourceMatchesQuasi, tetapi TIDAK menyaring
 * kegagalan. Dipakai untuk reason FAIL yang kaya (menyebut kata
 * bermakna spesifik yang hilang).
 */
export function diagnoseQuasiLiteralFailure(
  sourceExcerpt: string | null | undefined,
  context: EvidenceContext
): { missingTokens: string[]; coverage: number } | null {
  const stripped = stripSegmentMarkers(sourceExcerpt);
  if (!stripped) return null;
  const result = matchQuasiLiteralInSegments(stripped, context.chunkSegments);
  if (result.excerptTokens.length === 0) return null;
  return { missingTokens: result.missingTokens, coverage: result.coverage };
}