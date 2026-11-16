// ============================================================
// DUPLICATE VALIDATOR — GLOBAL GATE
// ============================================================
// Berjalan setelah semua evidence terkumpul.
// Tidak mengubah evidence secara destruktif.
// Menghasilkan candidate pairs dan resolution recommendations.
// ============================================================

import type { EvidenceItem } from '../types';
import { normalizeForSearch } from '../srt';
import { equalsNormalized } from '../text-matching'; // sudah diimpor, dipakai ulang di resolveIdenticalOccurrence

// ------------------------------------------------------------
// DUPLICATE CANDIDATE
// ------------------------------------------------------------

export interface DuplicateCandidate {
  evidenceA: EvidenceItem;
  evidenceB: EvidenceItem;
  similarity: number;
  reasons: string[];
}

// ------------------------------------------------------------
// RELATION TYPES
// ------------------------------------------------------------

export type SourceRelation = 'SAME' | 'DIFFERENT' | 'UNKNOWN';
export type ContextRelation = 'SAME' | 'DIFFERENT' | 'UNKNOWN';

// ------------------------------------------------------------
// RESOLVER ACTION
// ------------------------------------------------------------

export type ResolverAction = 'KEEP_FIRST' | 'KEEP_BEST' | 'MERGE' | 'PRESERVE';

export interface DuplicateResolution {
  evidence_id_a: string;
  evidence_id_b: string;
  action: ResolverAction;
  reason: string;
  mergedEvidence?: EvidenceItem; // hanya terisi jika action === 'MERGE'
  // BARU: pemenang eksplisit untuk KEEP_FIRST/KEEP_BEST. server.ts
  // sebelumnya menebak pemenang dengan mem-parsing substring `reason`
  // ("a lebih" / "b lebih") -- rapuh terhadap perubahan wording.
  // Field ini menggantikan kebutuhan parsing string sama sekali.
  keptId?: string;
} 

// ------------------------------------------------------------
// DUPLICATE RESULT
// ------------------------------------------------------------

export interface DuplicateResult {
  candidates: DuplicateCandidate[];
  duplicatePairs: DuplicateResolution[];
}

// ------------------------------------------------------------
// FINGERPRINT — Hanya untuk perbandingan diagnostik.
// Bukan blocking key. Digunakan untuk mendeteksi kecocokan
// multi-field yang kuat.
// ------------------------------------------------------------

function buildFingerprint(evidence: EvidenceItem): string {
  const parts = [
    normalizeForSearch(String(evidence.topic ?? '')),
    normalizeForSearch(String(evidence.subtopic ?? '')),
    normalizeForSearch(String(evidence.type ?? '')),
    normalizeForSearch(String(evidence.claim ?? '')),
    normalizeForSearch(String(evidence.value ?? '')),
    normalizeForSearch(String(evidence.unit ?? '')),
    normalizeForSearch(String(evidence.comparison_target ?? '')),
    normalizeForSearch(String(evidence.context ?? ''))
  ];

  return parts.join('|');
}

// ------------------------------------------------------------
// SOURCE RELATION
// ------------------------------------------------------------

function compareSourceRelation(
  evidenceA: EvidenceItem,
  evidenceB: EvidenceItem
): SourceRelation {
  const coordsA = evidenceA.source_coordinates;
  const coordsB = evidenceB.source_coordinates;

  if (!coordsA && !coordsB) {
    return 'UNKNOWN';
  }

  if (!coordsA || !coordsB) {
    return 'UNKNOWN';
  }

  // Source occurrence ditentukan oleh segment span,
  // bukan chunk_index. Chunk overlap dapat menyebabkan
  // segment yang sama muncul di chunk berbeda.
  const isSame =
    coordsA.segment_start_index === coordsB.segment_start_index &&
    coordsA.segment_end_index === coordsB.segment_end_index;

  return isSame ? 'SAME' : 'DIFFERENT';
}

// ------------------------------------------------------------
// CONTEXT RELATION
// ------------------------------------------------------------

function compareContextRelation(
  evidenceA: EvidenceItem,
  evidenceB: EvidenceItem
): ContextRelation {
  const contextA = normalizeForSearch(String(evidenceA.context ?? ''));
  const contextB = normalizeForSearch(String(evidenceB.context ?? ''));

  if (!contextA && !contextB) {
    return 'UNKNOWN';
  }

  if (!contextA || !contextB) {
    return 'UNKNOWN';
  }

  return contextA === contextB ? 'SAME' : 'DIFFERENT';
}

// ------------------------------------------------------------
// SIMILARITY CALCULATOR
// ------------------------------------------------------------

function calculateSimilarity(
  evidenceA: EvidenceItem,
  evidenceB: EvidenceItem
): number {
  let score = 0;
  const maxScore = 6;

  if (
    normalizeForSearch(String(evidenceA.topic ?? '')) ===
    normalizeForSearch(String(evidenceB.topic ?? ''))
  ) {
    score += 1;
  }

  if (
    normalizeForSearch(String(evidenceA.subtopic ?? '')) ===
    normalizeForSearch(String(evidenceB.subtopic ?? ''))
  ) {
    score += 1;
  }

  if (
    normalizeForSearch(String(evidenceA.type ?? '')) ===
    normalizeForSearch(String(evidenceB.type ?? ''))
  ) {
    score += 1;
  }

  const claimA = normalizeForSearch(String(evidenceA.claim ?? ''));
  const claimB = normalizeForSearch(String(evidenceB.claim ?? ''));

  if (claimA && claimB && claimA === claimB) {
    score += 2;
  } else if (claimA && claimB && (
    claimA.includes(claimB) || claimB.includes(claimA)
  )) {
    score += 1;
  }

  const excerptA = normalizeForSearch(String(evidenceA.source_excerpt ?? ''));
  const excerptB = normalizeForSearch(String(evidenceB.source_excerpt ?? ''));

  if (excerptA && excerptB && excerptA === excerptB) {
    score += 1;
  }

  return score / maxScore;
}

// ------------------------------------------------------------
// CHAIN-MERGE GROUPING
// ------------------------------------------------------------
// Masalah: kalau 3+ evidence saling bertaut sebagai duplicate
// (A↔B, A↔C, B↔C), resolver pairwise menghasilkan 3 resolution MERGE
// terpisah. Setelah diaplikasikan, muncul 3 merged evidence (bukan 1)
// -- duplikasi di output.
//
// Solusi: grup resolution MERGE berdasarkan connected component
// (union-find), dan hasilkan SATU resolution MERGE per grup.
// Evidence di grup yang sama digabung secara berurutan (fold left)
// menggunakan buildMergedEvidence(), yang sudah mengakumulasi
// merged_from_evidence_ids dan merged_subtopics.
//
// Non-MERGE pairs (PRESERVE, KEEP_FIRST, KEEP_BEST) dibiarkan apa adanya.

function groupMergeResolutions(
  pairs: DuplicateResolution[],
  candidates: DuplicateCandidate[]
): DuplicateResolution[] {
  // Lookup evidence by ID dari candidates.
  const evById = new Map<string, EvidenceItem>();
  for (const c of candidates) {
    if (c.evidenceA.evidence_id) evById.set(c.evidenceA.evidence_id, c.evidenceA);
    if (c.evidenceB.evidence_id) evById.set(c.evidenceB.evidence_id, c.evidenceB);
  }

  // Union-find.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const mergePairs = pairs.filter(p => p.action === 'MERGE');
  for (const p of mergePairs) {
    if (p.evidence_id_a && p.evidence_id_b) {
      union(p.evidence_id_a, p.evidence_id_b);
    }
  }

  // Group members by root.
  const groups = new Map<string, string[]>();
  for (const p of mergePairs) {
    if (!p.evidence_id_a || !p.evidence_id_b) continue;
    const root = find(p.evidence_id_a);
    let arr = groups.get(root);
    if (!arr) {
      arr = [];
      groups.set(root, arr);
    }
    if (!arr.includes(p.evidence_id_a)) arr.push(p.evidence_id_a);
    if (!arr.includes(p.evidence_id_b)) arr.push(p.evidence_id_b);
  }

  // Satu resolution MERGE per grup.
  const groupResolutions: DuplicateResolution[] = [];
  for (const ids of groups.values()) {
    const sortedIds = [...ids].sort();
    const evs = sortedIds
      .map(id => evById.get(id))
      .filter((e): e is EvidenceItem => !!e);

    if (evs.length < 2) continue;

    // Fold left: gabungkan semua evidence berurutan.
    let acc = evs[0];
    for (let i = 1; i < evs.length; i++) {
      acc = buildMergedEvidence(acc, evs[i]);
    }

    const isChain = sortedIds.length > 2;
    const reason = isChain
      ? `Chain-merge: ${sortedIds.length} evidence berbagi source occurrence ` +
        `dan source excerpt identik, digabung menjadi satu untuk menghindari ` +
        `duplikasi merged evidence.`
      : `Source occurrence dan source excerpt identik -- ` +
        `SHARED_PREDICATE_DUPLICATE_SPLIT. Digabung menjadi satu evidence.`;

    groupResolutions.push({
      evidence_id_a: sortedIds[0],
      evidence_id_b: sortedIds[1],
      action: 'MERGE',
      reason,
      mergedEvidence: acc
    });
  }

  // Non-MERGE pairs dipertahankan; MERGE digantikan oleh grup.
  const out: DuplicateResolution[] = pairs.filter(p => p.action !== 'MERGE');
  out.push(...groupResolutions);
  return out;
}

// ------------------------------------------------------------
// DETECT — Candidate detection tanpa destructive decision
// ------------------------------------------------------------

export const DuplicateValidator = {
  detect(
    evidenceList: EvidenceItem[]
  ): DuplicateResult {
    const candidates: DuplicateCandidate[] = [];

    for (let i = 0; i < evidenceList.length; i++) {
      for (let j = i + 1; j < evidenceList.length; j++) {
        const evidenceA = evidenceList[i];
        const evidenceB = evidenceList[j];

        const similarity = calculateSimilarity(
          evidenceA,
          evidenceB
        );

        // Strong occurrence candidate:
        // Source SAME + excerpt SAME → candidate deterministik
        const sourceRelation = compareSourceRelation(
          evidenceA,
          evidenceB
        );

        const excerptA = normalizeForSearch(
          String(evidenceA.source_excerpt ?? '')
        );
        const excerptB = normalizeForSearch(
          String(evidenceB.source_excerpt ?? '')
        );

        const strongOccurrenceCandidate =
          sourceRelation === 'SAME' &&
          !!excerptA &&
          !!excerptB &&
          excerptA === excerptB;

        // NEW: substring occurrence candidate. Source occurrence sama,
        // tapi excerpt berbeda -- yang satu substring yang lain. Ini pola
        // khas duplikat dari chunk overlap (CHUNK_OVERLAP di server.ts):
        // segmen SRT yang sama diproses di dua chunk berbeda, model
        // menghasilkan excerpt dengan wording sedikit berbeda.
        // Contoh: E054 "peak brightness-nya memang ada di 1025 nits"
        //      vs E056 "Sementara untuk peak brightness-nya memang ada
        //              di 1025 nits" (E054 ⊂ E056).
        const substringOccurrenceCandidate =
          sourceRelation === 'SAME' &&
          !!excerptA &&
          !!excerptB &&
          excerptA !== excerptB &&
          (excerptA.includes(excerptB) || excerptB.includes(excerptA));

        if (similarity >= 0.6 || strongOccurrenceCandidate || substringOccurrenceCandidate) {
          const reasons: string[] = [];

          const fingerprintA = buildFingerprint(evidenceA);
          const fingerprintB = buildFingerprint(evidenceB);

          if (fingerprintA === fingerprintB) {
            reasons.push('Fingerprint identik');
          }

          const claimA = normalizeForSearch(String(evidenceA.claim ?? ''));
          const claimB = normalizeForSearch(String(evidenceB.claim ?? ''));

          if (claimA && claimB && claimA === claimB) {
            reasons.push('Claim identik');
          } else if (claimA && claimB && (
            claimA.includes(claimB) || claimB.includes(claimA)
          )) {
            reasons.push('Claim mengandung satu sama lain');
          }

          if (excerptA && excerptB && excerptA === excerptB) {
            reasons.push('Source excerpt identik');
          }

          if (substringOccurrenceCandidate) {
            reasons.push('Substring occurrence candidate');
          }

          candidates.push({
            evidenceA,
            evidenceB,
            similarity,
            reasons
          });
        }
      }
    }

    return {
      candidates,
      duplicatePairs: groupMergeResolutions(
        candidates.map(candidate => resolveDuplicatePair(candidate)),
        candidates
      )
    };
  }
};

// ------------------------------------------------------------
// RESOLVER — Pairwise resolution recommendation
// ------------------------------------------------------------

function resolveDuplicatePair(
  candidate: DuplicateCandidate
): DuplicateResolution {
  const { evidenceA, evidenceB } = candidate;

  // 1. Source relation
  const sourceRelation = compareSourceRelation(
    evidenceA,
    evidenceB
  );

  if (sourceRelation === 'DIFFERENT') {
    return {
      evidence_id_a: evidenceA.evidence_id || '',
      evidence_id_b: evidenceB.evidence_id || '',
      action: 'PRESERVE',
      reason: 'Source occurrence berbeda, bukan duplicate'
    };
  }

  if (sourceRelation === 'UNKNOWN') {
    return {
      evidence_id_a: evidenceA.evidence_id || '',
      evidence_id_b: evidenceB.evidence_id || '',
      action: 'PRESERVE',
      reason: 'Source relation tidak dapat dibuktikan, preserve untuk keamanan'
    };
  }

  // 2. STRONG DUPLICATE EXCEPTION
  //    Source SAME + excerpt SAME
  //    → duplicate candidate kuat
  const excerptA = normalizeForSearch(
    String(evidenceA.source_excerpt ?? '')
  );
  const excerptB = normalizeForSearch(
    String(evidenceB.source_excerpt ?? '')
  );

    const isExcerptSame = excerptA === excerptB;

  if (
    sourceRelation === 'SAME' &&
    isExcerptSame
  ) {
    return resolveIdenticalOccurrenceOrMerge(evidenceA, evidenceB);
  }

  // NEW: substring case. Source occurrence sama, excerpt berbeda,
  // tapi salah satu mengandung yang lain. Ini duplikat dari chunk
  // overlap. Route ke handler khusus SEBELUM context relation check,
  // karena context biasanya berbeda (chunk berbeda = context bisa
  // beda) dan akan salah di-PRESERVE.
  if (
    sourceRelation === 'SAME' &&
    !!excerptA &&
    !!excerptB &&
    excerptA !== excerptB &&
    (excerptA.includes(excerptB) || excerptB.includes(excerptA))
  ) {
    return resolveSubstringOccurrence(evidenceA, evidenceB);
  }

  // 3. Context relation
  const contextRelation = compareContextRelation(
    evidenceA,
    evidenceB
  );

  if (contextRelation === 'DIFFERENT') {
    return {
      evidence_id_a: evidenceA.evidence_id || '',
      evidence_id_b: evidenceB.evidence_id || '',
      action: 'PRESERVE',
      reason: 'Context berbeda, bukan duplicate'
    };
  }

  if (contextRelation === 'UNKNOWN') {
    return {
      evidence_id_a: evidenceA.evidence_id || '',
      evidence_id_b: evidenceB.evidence_id || '',
      action: 'PRESERVE',
      reason: 'Context relation tidak dapat dibuktikan, preserve untuk keamanan'
    };
  }

  // 4. Source SAME + Context SAME
  //    Gunakan deterministic resolution
  return resolveIdenticalOccurrence(evidenceA, evidenceB);
}

// ------------------------------------------------------------
// RESOLVE IDENTICAL OCCURRENCE
// ------------------------------------------------------------
// BARU: deteksi apakah excerpt yang dibagi dua evidence secara eksplisit
// menjelaskan LEBIH DARI SATU referen/nilai sekaligus. Ini pembeda yang
// benar untuk menahan KEEP_FIRST/KEEP_BEST -- BUKAN kesamaan claim
// (lihat catatan D-01 di duplicate.test.ts: E139/E140 sama-sama
// menjelaskan SATU fakta dengan framing berbeda -- OPINION vs FACT --
// dan memang seharusnya KEEP_FIRST).
//
// Dikonfirmasi via replay data produksi 45hfkSE5DvA:
//   - "...untuk foto dan juga untuk video..." (E156/E157)      -> true
//   - "...4% baik di mode 120Hz maupun 60Hz"   (E181/E182)      -> true
//   - "tidak ada opsi perekaman 60 fps..."     (E139/E140)      -> false
//
// KETERBATASAN DIKETAHUI: pola "X dan Y" polos tanpa "untuk...dan juga"
// atau tanpa nilai numerik berulang (mis. "kamera selfie dan ultrawide
// yang perlu peningkatan...") TIDAK terdeteksi di sini -- lihat
// D-12 di duplicate.test.ts yang secara eksplisit mendokumentasikan
// ini sebagai gap terbuka, bukan regresi. Menambah pola "X dan Y" polos
// berisiko high false-positive karena kata "dan" sangat umum.
function excerptDescribesMultipleReferents(
  excerptA: string | null | undefined,
  excerptB: string | null | undefined
): boolean {
  const excerpt = (excerptA || excerptB || '').toLowerCase();

  const explicitSplitPattern =
    /\buntuk\b[^.!?]{0,20}\bdan juga\b[^.!?]{0,10}\buntuk\b|\bbaik\b[^.!?]{0,40}\bmaupun\b/i;
  if (explicitSplitPattern.test(excerpt)) return true;

  const numUnitPattern = /(\d+(?:[.,]\d+)?)\s*(hz|%|fps|mah|gb|jam|menit)\b/gi;
  const seenValuesPerUnit = new Map<string, Set<string>>();
  let m: RegExpExecArray | null;
  while ((m = numUnitPattern.exec(excerpt))) {
    const [, value, unit] = m;
    const key = unit.toLowerCase();
    if (!seenValuesPerUnit.has(key)) seenValuesPerUnit.set(key, new Set());
    seenValuesPerUnit.get(key)!.add(value);
  }
  for (const values of seenValuesPerUnit.values()) {
    if (values.size >= 2) return true;
  }

  return false;
}

// ------------------------------------------------------------
// COMPLETENESS SCORE — Memastikan KEEP_BEST memilih data terlengkap
// ------------------------------------------------------------
function getCompletenessScore(ev: EvidenceItem): number {
  let score = 0;
  if (ev.value !== null && ev.value !== undefined) score += 1;
  if (ev.unit !== null && ev.unit !== undefined) score += 1;
  if (ev.attribute) score += 1;
  if (ev.attribute_value) score += 1;
  if (ev.comparison_target) score += 1;
  if (ev.related_evidence_ids && ev.related_evidence_ids.length > 0) score += 2; // Relasi sangat berharga
  return score;
}

function resolveIdenticalOccurrence(
  evidenceA: EvidenceItem,
  evidenceB: EvidenceItem
): DuplicateResolution {
  if (excerptDescribesMultipleReferents(evidenceA.source_excerpt, evidenceB.source_excerpt)) {
    return {
      evidence_id_a: evidenceA.evidence_id || '',
      evidence_id_b: evidenceB.evidence_id || '',
      action: 'PRESERVE',
      reason:
        'Source occurrence dan source excerpt identik, tetapi excerpt ' +
        'secara eksplisit menjelaskan lebih dari satu referen/nilai ' +
        '(enumerasi "untuk X dan juga untuk Y" atau dua nilai numerik ' +
        'satuan sama) -- kemungkinan shared-predicate split dengan ' +
        'subtopic sama. Preserve untuk keamanan, bukan KEEP_FIRST.'
    };
  }

  // Gunakan skor kelengkapan yang lebih komprehensif (Fix #2)
  const scoreA = getCompletenessScore(evidenceA);
  const scoreB = getCompletenessScore(evidenceB);

  if (scoreA > scoreB) {
    return {
      evidence_id_a: evidenceA.evidence_id || '',
      evidence_id_b: evidenceB.evidence_id || '',
      action: 'KEEP_BEST',
      reason: `Evidence A lebih lengkap (skor kelengkapan ${scoreA} vs ${scoreB})`,
      keptId: evidenceA.evidence_id || ''
    };
  }

  if (scoreB > scoreA) {
    return {
      evidence_id_a: evidenceA.evidence_id || '',
      evidence_id_b: evidenceB.evidence_id || '',
      action: 'KEEP_BEST',
      reason: `Evidence B lebih lengkap (skor kelengkapan ${scoreB} vs ${scoreA})`,
      keptId: evidenceB.evidence_id || ''
    };
  }

  return {
    evidence_id_a: evidenceA.evidence_id || '',
    evidence_id_b: evidenceB.evidence_id || '',
    action: 'KEEP_FIRST',
    reason: 'Source occurrence dan source excerpt identik, skor kelengkapan sama',
    keptId: evidenceA.evidence_id || ''
  };
}

// ------------------------------------------------------------
// DISTINCT ASPECT CHECK
// ------------------------------------------------------------
// True jika dua evidence jelas-jelas membahas aspek berbeda,
// meskipun source occurrence-nya sama (segmen yang sama).
//
// Sinyal (prioritas dari paling kuat):
//   1. `attribute` berbeda non-null → aspek berbeda
//   2. `attribute_value` berbeda non-null (string-compare) → nilai
//      berbeda → aspek berbeda
//   3. `value` berbeda non-null (string-compare) → pengukuran berbeda
//
// Dipakai sebagai gate di resolveSubstringOccurrence: kalau dua
// evidence adalah aspek berbeda dari segmen yang sama, jangan
// di-dedup walau excerpt-nya substring. Contoh: E017 (count=3)
// vs E021 (color_option=Black) -- excerpt E017 substring E021,
// tapi aspeknya berbeda.
function isDistinctAspect(a: EvidenceItem, b: EvidenceItem): boolean {
  const norm = (v: unknown): string =>
    v === null || v === undefined ? '' : String(v).trim();

  const attrA = norm(a.attribute);
  const attrB = norm(b.attribute);
  if (attrA && attrB && attrA !== attrB) return true;

  const avA = norm(a.attribute_value);
  const avB = norm(b.attribute_value);
  if (avA && avB && avA !== avB) return true;

  const valA = norm(a.value);
  const valB = norm(b.value);
  if (valA && valB && valA !== valB) return true;

  return false;
}

// ------------------------------------------------------------
// RESOLVE SUBSTRING OCCURRENCE
// ------------------------------------------------------------
// Dua evidence dengan source occurrence yang sama (segmen SRT identik)
// tapi source_excerpt berbeda -- yang satu substring yang lain.
// Pola ini khas duplikat dari chunk overlap.
//
// Keputusan: KEEP_BEST dengan preferensi excerpt yang lebih panjang.
// Excerpt yang lebih panjang adalah superset dari yang lebih pendek
// (karena salah satu mengandung yang lain), sehingga mempertahankan
// lebih banyak konteks.
//
// Catatan tentang related_evidence_ids: evidence yang di-drop mungkin
// memiliki refs yang tidak ada di kept-evidence. Ref dari evidence lain
// yang menunjuk ke evidence yang di-drop akan di-redirect oleh
// redirectRelatedIds() setelah duplicate gate. Ref milik evidence yang
// di-drop sendiri akan hilang -- trade-off yang diterima, karena evidence
// yang di-drop memang duplikat dari kept-evidence.
function resolveSubstringOccurrence(
  evidenceA: EvidenceItem,
  evidenceB: EvidenceItem
): DuplicateResolution {
  // Guard aspek berbeda: substring occurrence TIDAK menjamin duplikat.
  // Kalau evidence jelas-jelas membahas aspek/nilai berbeda, jangan
  // di-dedup -- preserve keduanya. Ini mencegah false-positive pada
  // klaster evidence dari segmen yang sama (mis. 6 evidence dari
  // "opsi warnanya ada 3: Black, Peach Pink, Mint").
  if (isDistinctAspect(evidenceA, evidenceB)) {
    return {
      evidence_id_a: evidenceA.evidence_id || '',
      evidence_id_b: evidenceB.evidence_id || '',
      action: 'PRESERVE',
      reason:
        'Source occurrence sama dan excerpt substring, TAPI attribute/' +
        'attribute_value/value berbeda -- sinyal aspek berbeda dari ' +
        'satu segmen. Preserve kedua evidence untuk mempertahankan aspek.'
    };
  }
  
  const excerptA = normalizeForSearch(String(evidenceA.source_excerpt ?? ''));
  const excerptB = normalizeForSearch(String(evidenceB.source_excerpt ?? ''));

  // Tentukan pemenang: excerpt yang lebih panjang (superset).
  const aContainsB = excerptA.includes(excerptB);
  // Kalau excerptA === excerptB kita tidak akan sampai ke sini (sudah
  // ditangani isExcerptSame). Jadi aContainsB dan bContainsA bersifat
  // mutually exclusive di sini.
  const kept = aContainsB ? evidenceA : evidenceB;
  const keptExcerpt = aContainsB ? excerptA : excerptB;
  const droppedExcerpt = aContainsB ? excerptB : excerptA;

  return {
    evidence_id_a: evidenceA.evidence_id || '',
    evidence_id_b: evidenceB.evidence_id || '',
    action: 'KEEP_BEST',
    reason:
      `Source occurrence sama, excerpt berbeda dengan pola substring ` +
      `(substring occurrence). Excerpt yang lebih panjang dipilih ` +
      `karena mengandung lebih banyak konteks. ` +
      `Kept: "${keptExcerpt.slice(0, 60)}${keptExcerpt.length > 60 ? '…' : ''}", ` +
      `dropped: "${droppedExcerpt.slice(0, 60)}${droppedExcerpt.length > 60 ? '…' : ''}".`,
    keptId: kept.evidence_id || ''
  };
}

// ------------------------------------------------------------
// FIELD COMPATIBILITY CHECK — mencegah blind inheritance
// ------------------------------------------------------------
// buildMergedEvidence() mewarisi value/unit/comparison_target/
// certainty/topic dari evidenceA tanpa pengecekan. Kalau field-field
// ini ternyata BERBEDA antara evidenceA/evidenceB, itu sinyal bahwa
// kombinasi ini bukan murni SHARED_PREDICATE_DUPLICATE_SPLIT (satu
// proposisi yang salah dipecah) -- melainkan kemungkinan dua evidence
// independen yang kebetulan berbagi source occurrence + excerpt.
// Ditemukan lewat audit tim (co-auditor), dikonfirmasi terhadap kode.
// ------------------------------------------------------------

function fieldsCompatibleForMerge(
  evidenceA: EvidenceItem,
  evidenceB: EvidenceItem
): boolean {
  const norm = (v: unknown): string =>
    v === null || v === undefined ? '' : String(v);

  return (
    norm(evidenceA.value) === norm(evidenceB.value) &&
    norm(evidenceA.unit) === norm(evidenceB.unit) &&
    norm(evidenceA.comparison_target) === norm(evidenceB.comparison_target) &&
    norm(evidenceA.certainty) === norm(evidenceB.certainty) &&
    norm(evidenceA.topic) === norm(evidenceB.topic)
  );
}

// ------------------------------------------------------------
// SUBTOPIC SYNONYMY CHECK
// ------------------------------------------------------------
// Menentukan apakah dua subtopic merujuk ke objek/konsep yang SAMA,
// meskipun string-nya berbeda. Dipakai oleh gate SHARED_PREDICATE:
// kalau subtopic berbeda TAPI sinonim (mis. "warnanya" vs "warna",
// "display" vs "layar"), tetap MERGE. Kalau benar-benar berbeda
// (mis. "kamera-selfie" vs "kamera-ultrawide"), PRESERVE.
//
// Tiga level cek (dari paling murah):
//   1. Exact match pasca-normalisasi → sinonim
//   2. Substring: salah satu mengandung yang lain → sinonim
//      (mis. "warnanya" contains "warna")
//   3. Token Jaccard: mayoritas token sama → sinonim
//      Threshold 0.8 konservatif untuk menghindari false-positive
//      pada subtopic multi-kata yang berbagi satu kata
//      ("kamera selfie" vs "kamera ultrawide" → Jaccard 0.5 → berbeda).
function areSubtopicsSynonymous(sa: string, sb: string): boolean {
  const a = normalizeForSearch(sa);
  const b = normalizeForSearch(sb);
  if (!a || !b) return false;
  if (a === b) return true;

  // Substring morfologis: "warnanya" vs "warna"
  if (a.includes(b) || b.includes(a)) return true;

  // Token Jaccard
  const ta = new Set(a.split(' ').filter(Boolean));
  const tb = new Set(b.split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return false;
  const inter = [...ta].filter(t => tb.has(t)).length;
  const ratio = inter / Math.max(ta.size, tb.size);
  return ratio >= 0.8;
}

// ------------------------------------------------------------
// GATE — SHARED_PREDICATE DUPLICATE / DISTINCT SUBJECT
// ------------------------------------------------------------
// Source occurrence SAME + source_excerpt IDENTIK tidak otomatis
// berarti dua evidence boleh di-MERGE.
//
// Kontrak:
// 1. Subtopic berbeda dan bukan sinonim + type sama:
//    PRESERVE kedua evidence. Satu kalimat dapat menyebut beberapa
//    subjek dengan predikat yang sama; identitas setiap subjek harus
//    tetap dipertahankan.
// 2. Subtopic berbeda tetapi sinonim + type sama:
//    MERGE hanya jika fieldsCompatibleForMerge() terpenuhi.
// 3. Subtopic berbeda + type berbeda:
//    PRESERVE.
// 4. Subtopic sama/tidak berbeda:
// ------------------------------------------------------------

function resolveIdenticalOccurrenceOrMerge(
  evidenceA: EvidenceItem,
  evidenceB: EvidenceItem
): DuplicateResolution {
    const subtopicARaw = evidenceA.subtopic ?? '';
  const subtopicBRaw = evidenceB.subtopic ?? '';

  const hasDistinctSubtopics =
    !!subtopicARaw.trim() &&
    !!subtopicBRaw.trim() &&
    !equalsNormalized(subtopicARaw, subtopicBRaw);

  const sameType = (evidenceA.type ?? null) === (evidenceB.type ?? null);

    if (hasDistinctSubtopics && sameType) {
    // Subtopic yang berbeda dan bukan sinonim menunjukkan subjek
    // berbeda. Jangan satukan evidence hanya karena source occurrence,
    // excerpt, dan predicate-nya sama.

    if (!areSubtopicsSynonymous(subtopicARaw, subtopicBRaw)) {
      return {
        evidence_id_a: evidenceA.evidence_id || '',
        evidence_id_b: evidenceB.evidence_id || '',
        action: 'PRESERVE',
        reason:
          'Excerpt identik + type sama, tetapi subtopic merujuk ke objek ' +
          `berbeda (${subtopicARaw} vs ${subtopicBRaw}) dan bukan sinonim. ` +
          'Ini pola shared-predicate dengan DUA SUBJEK BERBEDA -- MERGE ' +
          'akan menghilangkan salah satu subjek. Preserve kedua evidence ' +
          'untuk mempertahankan subjek.'
      };
    }

    if (!fieldsCompatibleForMerge(evidenceA, evidenceB)) {
      return {
        evidence_id_a: evidenceA.evidence_id || '',
        evidence_id_b: evidenceB.evidence_id || '',
        action: 'PRESERVE',
        reason:
          'Excerpt identik + subtopic berbeda + type sama, TAPI value/unit/' +
          'comparison_target/certainty/topic tidak seluruhnya sama antara ' +
          'kedua evidence -- sinyal ini BUKAN murni ' +
          'SHARED_PREDICATE_DUPLICATE_SPLIT, melainkan kemungkinan dua ' +
          'evidence independen yang kebetulan berbagi source occurrence ' +
          'dan excerpt. Preserve untuk keamanan, bukan MERGE.'
      };
    }

    return {
      evidence_id_a: evidenceA.evidence_id || '',
      evidence_id_b: evidenceB.evidence_id || '',
      action: 'MERGE',
      reason:
        'Source occurrence dan source excerpt identik, tetapi subtopic berbeda ' +
        `(${evidenceA.subtopic} vs ${evidenceB.subtopic}) -- pola ` +
        'SHARED_PREDICATE_DUPLICATE_SPLIT: satu proposisi shared-predicate yang ' +
        'salah dipecah model. Digabung menjadi satu evidence.',
      mergedEvidence: buildMergedEvidence(evidenceA, evidenceB)
    };
  }

  if (hasDistinctSubtopics && !sameType) {
    return {
      evidence_id_a: evidenceA.evidence_id || '',
      evidence_id_b: evidenceB.evidence_id || '',
      action: 'PRESERVE',
      reason:
        'Excerpt identik + subtopic berbeda, tetapi type juga berbeda -- ' +
        'di luar pola SHARED_PREDICATE_DUPLICATE_SPLIT yang teramati, ' +
        'preserve untuk keamanan'
    };
  }

  return resolveIdenticalOccurrence(evidenceA, evidenceB);
}

// ------------------------------------------------------------
// STOPWORDS — untuk deteksi redundansi klaim hasil merge
// ------------------------------------------------------------
// Daftar minimal: hanya kata fungsi (function words) yang sering
// mem-padding kalimat tanpa mengubah makna. Kata benda, kata kerja
// utama, angka, dan satuan TIDAK masuk list ini.
//
// Tujuan: setelah stopword removal, dua klaim yang menyatakan
// proposisi sama akan punya token overlap tinggi meskipun wording
// berbeda ("adalah" vs "terdiri dari", "saat" vs "untuk", dst).
const MERGE_STOPWORDS = new Set([
  // Indonesia — kata fungsi
  'adalah', 'ialah', 'itu', 'ini', 'yang', 'di', 'ke', 'dari',
  'dan', 'atau', 'pada', 'dengan', 'oleh', 'akan', 'untuk',
  'saat', 'telah', 'sudah', 'ada', 'juga', 'tapi', 'tetapi',
  'namun', 'karena', 'sebagai', 'jika', 'kalau', 'bila', 'agar',
  'supaya', 'hanya', 'saja', 'masih', 'belum', 'bukan', 'tidak',
  'sehingga', 'maka', 'bahwa', 'antara', 'bagi', 'terhadap',
  'tentang', 'mengenai', 'daripada', 'kepada', 'dalam', 'secara',
  // English — function words
  'the', 'a', 'an', 'is', 'are', 'of', 'to', 'in', 'on', 'at',
  'by', 'for', 'with', 'and', 'or', 'but', 'that', 'this'
]);

function tokenizeForMerge(text: string): Set<string> {
  return new Set(
    normalizeForSearch(text)
      .split(' ')
      .filter(t => t.length > 0 && !MERGE_STOPWORDS.has(t))
  );
}

function mergeClaims(claimA: string | undefined, claimB: string | undefined): string {
  const a = (claimA || '').trim();
  const b = (claimB || '').trim();
  if (!a) return b;
  if (!b) return a;

  const na = normalizeForSearch(a);
  const nb = normalizeForSearch(b);

  // Identik → pilih a
  if (na === nb) return a;

  // Satu mengandung yang lain → pilih yang lebih panjang (tanpa kehilangan info)
  if (na.includes(nb)) return a;
  if (nb.includes(na)) return b;

  // Superset kata → pilih yang lebih panjang HANYA jika SEMUA token klaim
  // yang lebih pendek ada di klaim yang lebih panjang.
  const tokensA = tokenizeForMerge(a);
  const tokensB = tokenizeForMerge(b);

  const [shorter, longer, longerText] =
    tokensA.size <= tokensB.size ? [tokensA, tokensB, b] : [tokensB, tokensA, a];
  if ([...shorter].every(t => longer.has(t))) return longerText;

  // ── REDUNDANCY GUARD ─────────────────────────────────────
  // Kasus yang ingin dihindari: dua klaim yang menyatakan
  // proposisi SAMA dengan wording berbeda, mis.
  //   A: "Salah satu opsi warna adalah Black"
  //   B: "Opsi warna terdiri dari Black"
  // Keduanya proposisi yang sama → concat akan menghasilkan
  // "… Black. Opsi warna terdiri dari Black" yang redundan.
  //
  // Deteksi: containment (intersection / min_size) ≥ 0.7.
  //
  // GUARD: jangan merge jika:
  //   - kedua klaim sama panjang (indikasi klaim paralel, bukan
  //     redundant; mis. E193 "selfie perlu peningkatan" vs
  //     "ultrawide perlu peningkatan" — dua subjek berbeda)
  //   - DAN tidak ada angka di kedua klaim (angka adalah pembeda
  //     faktual paling andal)
  //
  // Kalau guard terpicu, fallback ke concat — lebih baik redundan
  // daripada kehilangan subjek.
  const intersection = new Set(
    [...tokensA].filter(t => tokensB.has(t))
  );
  const minSize = Math.min(tokensA.size, tokensB.size);
  const containment = minSize > 0 ? intersection.size / minSize : 0;

  const sameLength = tokensA.size === tokensB.size;
  const noNumbers = !/\d/.test(na) && !/\d/.test(nb);

  if (containment >= 0.7 && !(sameLength && noNumbers)) {
    return longerText;
  }

  // Informasi berbeda (mis. subjek berbeda) → gabung literal agar tidak ada
  // subjek yang hilang. Titik akhir klaim pertama dibuang agar tidak ganda.
  return `${a.replace(/[.\s]+$/, '')}. ${b}`;
}

function buildMergedEvidence(
  evidenceA: EvidenceItem,
  evidenceB: EvidenceItem
): EvidenceItem {
  // Akumulasi subtopics — termasuk dari evidence yang sudah pernah dimerge.
  // Kalau evidenceA.merged_subtopics ada (dari merge sebelumnya), pakai itu;
  // kalau tidak, fallback ke subtopic tunggalnya.
  const candidates: string[] = [];
  const pushCandidates = (ev: EvidenceItem) => {
    if (ev.merged_subtopics && ev.merged_subtopics.length > 0) {
      candidates.push(...ev.merged_subtopics);
    } else if (ev.subtopic && ev.subtopic.trim()) {
      candidates.push(ev.subtopic);
    }
  };
  pushCandidates(evidenceA);
  pushCandidates(evidenceB);

  // Fix #4: dedup synonym-aware. Sebelumnya hanya exact-string match
  // (Set<string>), sehingga sinonim morfologis seperti "warnanya" vs
  // "warna" tetap muncul ganda di merged_subtopics.
  //
  // Kebijakan winner: kalau dua subtopic sinonim, simpan yang LEBIH
  // PENDEK (biasanya lebih kanonik: "warna" > "warnanya",
  // "display" > "display-nya"). Kalau panjang sama, pertahankan yang
  // sudah ada (first-seen).
  const subtopics: string[] = [];
  for (const candidate of candidates) {
    let replaced = false;
    for (let i = 0; i < subtopics.length; i++) {
      if (areSubtopicsSynonymous(subtopics[i], candidate)) {
        if (candidate.length < subtopics[i].length) {
          subtopics[i] = candidate;
        }
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      subtopics.push(candidate);
    }
  }

  // Akumulasi merged_from_evidence_ids (dedup, preserve order).
  const mergedFromSet = new Set<string>();
  const mergedFromIds: string[] = [];
  const pushId = (id: string | null | undefined) => {
    if (id && !mergedFromSet.has(id)) {
      mergedFromSet.add(id);
      mergedFromIds.push(id);
    }
  };
  if (evidenceA.merged_from_evidence_ids) {
    evidenceA.merged_from_evidence_ids.forEach(pushId);
  } else if (evidenceA.evidence_id) {
    pushId(evidenceA.evidence_id);
  }
  if (evidenceB.merged_from_evidence_ids) {
    evidenceB.merged_from_evidence_ids.forEach(pushId);
  } else if (evidenceB.evidence_id) {
    pushId(evidenceB.evidence_id);
  }

  const contextSame =
    normalizeForSearch(String(evidenceA.context ?? '')) ===
    normalizeForSearch(String(evidenceB.context ?? ''));

  const assessmentSame =
    evidenceA.reviewer_assessment === evidenceB.reviewer_assessment;

  return {
    // source_excerpt, source_coordinates, type, topic, value, unit,
    // comparison_target, certainty diwariskan dari evidenceA karena
    // resolveIdenticalOccurrenceOrMerge() menjamin source occurrence +
    // source_excerpt identik.
    ...evidenceA,
    claim: mergeClaims(evidenceA.claim, evidenceB.claim),
    subtopic: null,
    context: contextSame ? (evidenceA.context ?? evidenceB.context ?? null) : null,
    reviewer_assessment: assessmentSame
      ? (evidenceA.reviewer_assessment ?? null)
      : null,
    merged_subtopics: subtopics.length > 0 ? subtopics : null,
    merged_from_evidence_ids: mergedFromIds.length > 0 ? mergedFromIds : null,
    validation: evidenceA.validation
  };
}