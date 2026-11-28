// ============================================================
// AMBIGUOUS REPORT — diagnosis karantina PROVENANCE AMBIGUOUS
// ============================================================
// Dipakai scripts/replay-run.ts lewat flag --ambiguous-report.
// Tanpa API, murni replay. Tujuan: memisahkan AKAR MASALAH karantina
// "source_excerpt ambiguous" supaya obatnya tepat (prompt vs resolver
// vs memang duplikat sah).
//
// Kategori (urutan pengecekan = urutan prioritas):
//   NO_ANCHOR              subtopic null/kosong -> prompt: wajib isi
//   GENUINE_DUPLICATE      semua kandidat berisi teks segmen identik
//                          -> memang tidak bisa dibedakan, karantina SAH
//   ANCHOR_ECHO            subtopic hanya mengulang isi excerpt
//                          (mis. "6,7-inci") -> prompt: larang echo nilai
//   ANCHOR_GENERIC         anchor mendukung >1 kandidat di span sempit
//                          (mis. "kamera", "layar") -> prompt: anchor spesifik
//   ANCHOR_GENERIC_WIDE    fase 1 = 0, tapi fase 2 (radius) mendukung >1
//   ANCHOR_OUTSIDE_RADIUS  anchor ADA di chunk tapi di luar radius semua
//                          kandidat -> kandidat fase 3 resolver (product-aware)
//   ANCHOR_NOT_LITERAL     anchor TIDAK ada di chunk sama sekali
//                          (mis. "camera-selfie" vs "kamera selfie")
//                          -> prompt: ejaan harus mengikuti transkrip
//   UNEXPECTED             resolver seharusnya RESOLVED; cek drift kode
//
// CATATAN DRIFT: helper di bawah mereplikasi logika internal
// anchor-resolver.ts (tidak diekspor). Kalau resolver berubah,
// sesuaikan di sini.
// ============================================================

import { MAX_VALIDATION_SPAN, findSourceMatches } from '../src/evidence/search';
import { normalizeForSearch } from '../src/evidence/srt';
import type { SRTSegment } from '../src/evidence/srt';
import {
  ANCHOR_EXPANSION_RADIUS,
  diagnoseProductVeto,
  selectProductHint
} from '../src/evidence/validators/anchor-resolver';
import type { EvidenceContext, SegmentMatch } from '../src/evidence/types';

export type AmbiguityCategory =
  | 'PRODUCT_VETO_FAILED'
  | 'NO_ANCHOR'
  | 'GENUINE_DUPLICATE'
  | 'ANCHOR_ECHO'
  | 'ANCHOR_GENERIC'
  | 'ANCHOR_GENERIC_WIDE'
  | 'ANCHOR_OUTSIDE_RADIUS'
  | 'ANCHOR_NOT_LITERAL'
  | 'UNEXPECTED';

const ADVICE: Record<AmbiguityCategory, string> = {
  PRODUCT_VETO_FAILED: 'klaim memuat produk tapi veto gagal: lihat DETAIL (mention hilang / multi-match / varian)',
  NO_ANCHOR: 'prompt: subtopic wajib terisi bila excerpt generik',
  GENUINE_DUPLICATE: 'teks kandidat identik; hanya konteks produk yang bisa membedakan (pastikan klaim memuat produk)',
  ANCHOR_ECHO: 'prompt: larang subtopic berisi nilai/angka dari excerpt',
  ANCHOR_GENERIC: 'prompt: subtopic harus spesifik (bukan "kamera"/"layar")',
  ANCHOR_GENERIC_WIDE: 'prompt: subtopic harus spesifik; jangan naikkan radius',
  ANCHOR_OUTSIDE_RADIUS: 'resolver: kandidat fase 3 (product-aware / mention terdekat)',
  ANCHOR_NOT_LITERAL: 'prompt: ejaan subtopic ikuti transkrip (kontradiksi "English kanonik")',
  UNEXPECTED: 'investigasi: resolver mestinya RESOLVED'
};

export interface AmbiguousInput {
  runId: string;
  chunk: number;          // 1-based
  pos: number;
  type: string;
  claim: string;
  excerpt: string;
  subtopic: string | null;
  segments: SRTSegment[]; // segmen chunk asal
  evContext?: string | null;
  allSegments?: SRTSegment[];
}

export interface AmbiguityDiagnosis {
  category: AmbiguityCategory;
  candidates: SegmentMatch[];
  anchorNorm: string;
  detail: string;
}

function hasWord(normText: string, normAnchor: string): boolean {
  return ` ${normText} `.includes(` ${normAnchor} `);
}

function spanText(c: SegmentMatch, segs: SRTSegment[]): string {
  return segs
    .filter(s => s.index >= c.segmentStartIndex && s.index <= c.segmentEndIndex)
    .map(s => s.text)
    .join(' ');
}

function expandedText(c: SegmentMatch, segs: SRTSegment[], radius: number): string {
  const lo = c.segmentStartIndex - radius;
  const hi = c.segmentEndIndex + radius;
  return segs.filter(s => s.index >= lo && s.index <= hi).map(s => s.text).join(' ');
}

export function classifyAmbiguity(inp: AmbiguousInput): AmbiguityDiagnosis {
  const ctx: EvidenceContext = {
    chunkIndex: inp.chunk - 1,
    chunkText: inp.segments.map(s => s.text).join(' '),
    chunkSegments: inp.segments,
    allSegments: inp.allSegments
  };
  const candidates = findSourceMatches(inp.excerpt, ctx, { maxSpan: MAX_VALIDATION_SPAN });
  const anchorNorm = normalizeForSearch(inp.subtopic || '');
  const done = (category: AmbiguityCategory, detail: string): AmbiguityDiagnosis =>
    ({ category, candidates, anchorNorm, detail });

  // Klaim memuat produk: veto sudah dicoba resolver, jadi yang tersisa = gagal.
  const hint = selectProductHint(inp.claim, inp.evContext);
  if (hint) {
    const diag = diagnoseProductVeto(candidates, hint, ctx);
    if (diag.reason !== 'NO_HINT' && diag.reason !== 'MIXED_HINT') {
      return done(
        diag.reason === 'OK' ? 'UNEXPECTED' : 'PRODUCT_VETO_FAILED',
        `${diag.reason}: ${diag.perCandidate.join(' | ')}`
      );
    }
  }

  if (!anchorNorm) return done('NO_ANCHOR', 'subtopic kosong');

  const candTexts = candidates.map(c => normalizeForSearch(spanText(c, inp.segments)));
  if (candTexts.length > 1 && candTexts.every(t => t === candTexts[0])) {
    return done('GENUINE_DUPLICATE', `${candidates.length} kandidat bertext identik`);
  }

  const excerptNorm = normalizeForSearch(inp.excerpt);
  if (hasWord(excerptNorm, anchorNorm)) {
    return done('ANCHOR_ECHO', `anchor "${anchorNorm}" ada di dalam excerpt itu sendiri`);
  }

  const narrow = candidates.filter(c =>
    hasWord(normalizeForSearch(spanText(c, inp.segments)), anchorNorm));
  if (narrow.length > 1) {
    return done('ANCHOR_GENERIC', `anchor mendukung ${narrow.length}/${candidates.length} kandidat (span sempit)`);
  }
  if (narrow.length === 1) {
    return done('UNEXPECTED', 'fase 1 mendukung tepat 1 kandidat');
  }

  const wide = candidates.filter(c =>
    hasWord(normalizeForSearch(expandedText(c, inp.segments, ANCHOR_EXPANSION_RADIUS)), anchorNorm));
  if (wide.length > 1) {
    return done('ANCHOR_GENERIC_WIDE', `fase 2 mendukung ${wide.length}/${candidates.length} kandidat`);
  }
  if (wide.length === 1) {
    return done('UNEXPECTED', 'fase 2 mendukung tepat 1 kandidat');
  }

  // narrow = 0 dan wide = 0: anchor ada di chunk atau tidak?
  const presentIdx = inp.segments
    .filter(s => hasWord(normalizeForSearch(s.text), anchorNorm))
    .map(s => s.index);

  if (presentIdx.length === 0) {
    const missing = anchorNorm.split(' ').filter(t =>
      !inp.segments.some(s => hasWord(normalizeForSearch(s.text), t)));
    return done(
      'ANCHOR_NOT_LITERAL',
      `anchor "${anchorNorm}" tidak ada di chunk; token hilang: ${missing.join(', ') || '(urutan frasa beda)'}`
    );
  }

  const dists = candidates.map(c => {
    const d = Math.min(...presentIdx.map(i =>
      i < c.segmentStartIndex ? c.segmentStartIndex - i
        : i > c.segmentEndIndex ? i - c.segmentEndIndex : 0));
    return `${c.segmentStartIndex}${c.segmentEndIndex !== c.segmentStartIndex ? '-' + c.segmentEndIndex : ''}:jarak ${d}`;
  });
  return done(
    'ANCHOR_OUTSIDE_RADIUS',
    `anchor di seg [${presentIdx.join(',')}]; kandidat -> ${dists.join(' | ')}`
  );
}

// ------------------------------------------------------------
// Pengumpulan dari hasil replay (tipe longgar agar tidak impor
// tipe privat replay-run.ts)
// ------------------------------------------------------------
export function collectAmbiguous(results: Array<{
  run: { run_id: string };
  items: Array<{
    accepted: boolean; chunk: number; pos: number; type: string;
    claim: string; excerpt: string; subtopic?: string | null; context?: string | null;
    blockingDetails?: Array<{ rule: string; reason: string }>;
  }>;
  chunkSegments?: Map<number, SRTSegment[]>;
  allSegments?: SRTSegment[];
}>): AmbiguousInput[] {
  const out: AmbiguousInput[] = [];
  for (const r of results) {
    for (const it of r.items) {
      if (it.accepted) continue;
      const hit = (it.blockingDetails ?? []).some(
        d => d.rule === 'PROVENANCE' && /ambiguous/i.test(d.reason));
      if (!hit) continue;
      const segments = r.chunkSegments?.get(it.chunk);
      if (!segments) continue;
      out.push({
        runId: r.run.run_id, chunk: it.chunk, pos: it.pos, type: it.type,
        claim: it.claim, excerpt: it.excerpt, subtopic: it.subtopic ?? null, segments
        , evContext: it.context ?? null, allSegments: r.allSegments
      });
    }
  }
  return out;
}

function trunc(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

export function printAmbiguousReport(inputs: AmbiguousInput[], full: boolean, perCategory: number): void {
  console.log('='.repeat(78));
  console.log(`AMBIGUOUS REPORT  (${inputs.length} karantina PROVENANCE ambiguous, radius=${ANCHOR_EXPANSION_RADIUS})`);
  console.log('='.repeat(78));
  if (inputs.length === 0) { console.log('  (tidak ada)'); return; }

  const diag = inputs.map(i => ({ i, d: classifyAmbiguity(i) }));
  const byCat = new Map<AmbiguityCategory, typeof diag>();
  for (const x of diag) {
    const arr = byCat.get(x.d.category) ?? [];
    arr.push(x);
    byCat.set(x.d.category, arr);
  }

  console.log('\n  Ringkasan kategori:');
  for (const [cat, arr] of [...byCat].sort((a, b) => b[1].length - a[1].length)) {
    const pct = ((arr.length / inputs.length) * 100).toFixed(1);
    console.log(`    ${cat.padEnd(24)}${String(arr.length).padEnd(6)}${(pct + '%').padEnd(8)}-> ${ADVICE[cat]}`);
  }

  console.log('\n  Per run:');
  const perRun = new Map<string, Map<AmbiguityCategory, number>>();
  for (const x of diag) {
    const m = perRun.get(x.i.runId) ?? new Map<AmbiguityCategory, number>();
    m.set(x.d.category, (m.get(x.d.category) ?? 0) + 1);
    perRun.set(x.i.runId, m);
  }
  for (const [run, m] of perRun) {
    console.log(`    ${run.slice(0, 19)}_${run.split('_').pop()}  ` +
      [...m].map(([k, v]) => `${k}=${v}`).join('  '));
  }

  for (const [cat, arr] of byCat) {
    const subs = new Map<string, number>();
    for (const x of arr) {
      const k = x.i.subtopic ?? '(null)';
      subs.set(k, (subs.get(k) ?? 0) + 1);
    }
    const top = [...subs].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([k, v]) => `${k}×${v}`).join(', ');
    console.log(`\n--- ${cat} (${arr.length}) | top subtopic: ${top}`);
    const shown = full ? arr : arr.slice(0, perCategory);
    for (const x of shown) {
      console.log(`  [${x.i.runId.slice(11, 19)} c${x.i.chunk}#${x.i.pos}] ${x.i.type} | subtopic=${x.i.subtopic ?? 'null'} | kandidat=${x.d.candidates.length}`);
      console.log(`      EXCERPT: ${trunc(x.i.excerpt, 110)}`);
      console.log(`      CLAIM  : ${trunc(x.i.claim, 110)}`);
      console.log(`      DETAIL : ${trunc(x.d.detail, 170)}`);
    }
    if (!full && arr.length > shown.length) {
      console.log(`  ... ${arr.length - shown.length} lagi (pakai --full)`);
    }
  }
}
