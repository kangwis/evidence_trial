// ============================================================
// SRT POST-PROCESSOR
// ============================================================
// Dijalankan setelah LLM selesai mengoreksi SRT.
// Berisi:
//   1. Normalisasi deterministik (Victus Plus -> Victus+)
//   2. Deteksi duplikasi antar-segmen
// ============================================================

import type { SRTSegment } from '../evidence/srt';

// ------------------------------------------------------------
// 1. NORMALISASI DETERMINISTIK
// ------------------------------------------------------------
// Frasa unik yang tidak akan bentrok dengan istilah lain.
// JANGAN tambahkan "Full HD" polos di sini -- itu ambigu.

const POST_NORMALIZE: Array<[RegExp, string]> = [
  [/\bVictus Plus\b/g, 'Victus+'],
  [/\bFull HD Plus\b/g, 'Full HD+'],
];

export function applyPostNormalize(text: string): string {
  return POST_NORMALIZE.reduce(
    (acc, [re, rep]) => acc.replace(re, rep),
    text
  );
}

// ------------------------------------------------------------
// 2. DETEKSI DUPLIKASI ANTAR-SEGMEN
// ------------------------------------------------------------
// Deteksi frasa >= 5 kata yang muncul di dua segmen berurutan.
// Pola bug: LLM memindahkan teks dari segmen N+1 ke segmen N,
// lalu tidak menghapusnya dari segmen N+1.

function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectCrossSegmentDuplication(
  segments: SRTSegment[]
): string[] {
  const issues: string[] = [];

  for (let i = 0; i < segments.length - 1; i++) {
    const a = normalizeForCompare(segments[i].text);
    const b = normalizeForCompare(segments[i + 1].text);
    if (!a || !b) continue;

    const wordsA = a.split(' ').filter(Boolean);
    if (wordsA.length < 5) continue;

    // Cek window 5-kata dari segmen A yang muncul di segmen B
    for (let start = 0; start <= wordsA.length - 8; start++) {
      const phrase = wordsA.slice(start, start + 8).join(' ');
      if (b.includes(phrase)) {
        issues.push(
          `Segmen ${segments[i].index}-${segments[i + 1].index}: ` +
          `frasa "${phrase}" duplikat`
        );
        break;
      }
    }
  }

  return issues;
}