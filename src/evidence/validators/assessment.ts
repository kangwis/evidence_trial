// ============================================================
// ASSESSMENT VALIDATOR — v6
// ============================================================
// Hanya OPINION yang boleh memiliki reviewer_assessment.
// Semua type lain WAJIB null.
//
// RIWAYAT VERSI (ASSESSMENT_RULES_VERSION; dicetak oleh replay-run.ts)
//   legacy        : semua kata evaluatif pada type non-OPINION =
//                   SUSPECT HIGH; claim + excerpt dipindai sekaligus.
//   assessment-v2 : whitelist "cukup" hanya menetralkan frasa itu sendiri;
//                   "kurang dari" dinetralkan; severity bergantung type.
//   assessment-v2.1: SUSPECT LOW kini pass:true.
//   assessment-v3 : OBSERVATION dihapus dari FLAG_ONLY_TYPES;
//                   `agak` dikembalikan; tambah terlalu/oke/hebat/
//                   sangat/jauh; tambah discourse marker untuk `oke`.
//   assessment-v4 : Leksikon 3-tier (CORE / INTENSIFIER / CONTEXT).
//                   Hasil: 84 → 32 karantina (−62%).
//   assessment-v5 : Blocking hanya dari EXCERPT (claim = paraphrase
//                   model). Context guard diperluas. Hasil: 32 → 37
//                   karantina (naik, karena excerpt-hit jadi block).
//   assessment-v6 : Fix 6 pola false positive dari audit v5, TANPA
//                   mengubah policy (tetap block jika excerpt memuat
//                   kata evaluatif pada type non-OPINION). Fokus:
//                   (1) minim + adverb + metric ("minim terasa frame
//                       drop") — tambah filler.
//                   (2) Reverse pattern "noise-nya minim", "noise-nya
//                       juga minim" — tambah guard dua arah.
//                   (3) kurang + cahaya/pencahayaan/lampu/sinar dalam
//                       berbagai bentuk ("cahayanya kurang").
//                   (4) jauh + komparasi kuantitatif ("lumayan jauh
//                       sekitar 0,6 mm").
//                   (5) "paling buruk" sebagai worst-case quantifier
//                       setelah range angka ("40-30 paling buruk").
//                   (6) Discourse framing "pertama kita bahas yang
//                       bagus lagi dulu" — tambah discourse marker.
//   assessment-v7 : Pindah 'buruk' dan 'jelek' dari EVALUATIVE_CORE ke
//                   CONTEXT_EVALUATIVE. Alasan: keduanya sering muncul
//                   sebagai worst-case quantifier setelah range angka
//                   ("40-30 paling buruk") — deskripsi, bukan penilaian.
//                   Guard "paling buruk|jelek" di CONTEXT_NEUTRALIZERS
//                   (sudah ada sejak v6) sekarang efektif untuk keduanya.
//                   Hasil: 32 → ~31 karantina.
//
//   assessment-v8 : Deteksi kontekstual "cukup" diperluas untuk
//                   penilaian kecukupan ("cukup untuk seharian",
//                   "cukup bisa diandalkan", "cukup kalau dipakai")
//                   tanpa menganggap instruksi ("cukup melakukan")
//                   dan kuantitas ("cukup banyak") sebagai evaluasi.
//                   findEvaluativeWords mengembalikan kata pemicu unik,
//                   bukan kata sekaligus frasa turunannya.
//                   Reason HIGH menyebut source_excerpt secara eksplisit.
// ============================================================
// FILOSOFI (DIPERTAHANKAN DARI v5)
// ============================================================
// source_excerpt adalah KONTRAK LITERAL dengan sumber (SRT). Kalau
// excerpt memuat kata evaluatif pada type non-OPINION, maka type
// pasti salah klasifikasi — model salah pilih OPINION vs OBSERVATION.
// Ini layak dikarantina (policy B).
//
// `claim` adalah field yang model KARANG dari excerpt. Model sering
// menambahkan kata evaluatif di claim yang TIDAK ADA di sumber.
// Kata-kata itu tidak membuktikan apa pun tentang klasifikasi.
// Blocking-only-from-excerpt membuat validator jujur pada kontrak:
// "kalau excerpt literal bersih, jenis klaim = model's own framing".
// ============================================================

import type { ValidationResult } from '../types';

export const ASSESSMENT_RULES_VERSION = 'assessment-v8';

const ALLOWED_TYPES_FOR_ASSESSMENT = ['OPINION'];

// Type yang kata evaluatifnya di EXCERPT hanya ditandai (severity LOW).
// Type lain (FACT, MEASUREMENT, OBSERVATION, tak dikenal) memblokir
// (HIGH) jika excerpt memuat kata evaluatif.
const FLAG_ONLY_TYPES = new Set(['RECOMMENDATION', 'COMPARISON', 'CLAIM']);

// Nilai placeholder yang berarti "kosong".
const NULLISH_ASSESSMENT = new Set(['', 'null', 'none', 'n/a', 'na', '-', 'undefined']);

// ------------------------------------------------------------
// TIER 1: EVALUATIVE_CORE — selalu trigger
// ------------------------------------------------------------
// Kata/frasa yang secara inheren menyampaikan penilaian subjektif.
// Tidak bisa di-neutralize oleh konteks apa pun. Setiap hit di
// excerpt → block (HIGH) untuk type non-FLAG_ONLY.
export const EVALUATIVE_CORE: readonly string[] = [
  'bagus', 'cakep', 'keren', 'mantap',
  'hebat', 'jempolan', 'premium', 'memadai', 'oke',
  'mengecewakan', 'mengesankan', 'layak', 'recommended',
  'luar biasa',
  'worth it',
  // 'buruk' dan 'jelek' DIPINDAH ke CONTEXT_EVALUATIVE (v7) supaya bisa
  // di-neutralize oleh guard "paling buruk/jelek" (worst-case quantifier
  // setelah range angka). Contoh: "40-30 paling buruk" → deskripsi
  // worst-case, bukan penilaian.
];

// ------------------------------------------------------------
// TIER 2: INTENSIFIER — TIDAK trigger
// ------------------------------------------------------------
// Kata yang mengubah INTENSITAS, bukan menyampaikan penilaian.
export const INTENSIFIER: readonly string[] = [
  'sangat', 'agak', 'cukup', 'terlalu', 'tergolong', 'terbilang',
  'banget', 'super', 'sekali', 'amat',
];

// ------------------------------------------------------------
// TIER 3: CONTEXT_EVALUATIVE — trigger kecuali di-neutralize
// ------------------------------------------------------------
export const CONTEXT_EVALUATIVE: readonly string[] = [
  'kurang', 'minim', 'jauh',
  // v7: dipindah dari CORE — bisa di-neutralize oleh "paling buruk/jelek"
  // sebagai worst-case quantifier setelah range angka.
  'buruk', 'jelek',
];

// ------------------------------------------------------------
// NEUTRALIZERS — frasa yang dinetralkan sebelum pencocokan
// ------------------------------------------------------------

// Idiom umum (tidak bisa jadi evaluatif dalam bentuk ini).
const NEUTRAL_IDIOMS: RegExp[] = [
  /\bkurang\s+lebih\b/gi,        // approximation ("kira-kira")
  /\bkurang\s+dari\b/gi,          // numeric comparator ("< 3 juta")
  // deskripsi kondisi penguji
  /\bagak(?:-agak)?\s+(?:keringatan|berkeringat|lembab|basah)\b/gi,
];

// Whitelist frasa teknis (existing v2/v3).
export const TECHNICAL_WHITELIST_PHRASES: readonly string[] = [
  'minim noise',
  'noise-nya itu minim',
  'noise nya itu minim',
  'minim jitter',
  'tergolong konsisten',
  'tergolong tipis',
];

// Context guard untuk CONTEXT_EVALUATIVE.
const CONTEXT_NEUTRALIZERS: RegExp[] = [
  // ============================================================
  // -- existing v4 --
  // ============================================================
  // minim: deskripsi kondisi pencahayaan
  /\bminim\s+(?:cahaya|lampu|pencahayaan|sinar)\w*\b/gi,
  // jauh: komparatif netral
  /\b(?:nggak|tidak|ga|gak|tak|tdk)\s+(?:beda|berbeda|terlalu)\s+jauh\b/gi,
  /\b(?:beda|berbeda)\s+jauh\b/gi,
  // jauh: negasi
  /\b(?:nggak|tidak|ga|gak|tak|tdk)\s+jauh\b/gi,

  // ============================================================
  // -- v5 --
  // ============================================================
  // minim + metric (forward, 0 filler)
  /\bminim\s+(?:noise|frame\s*drop|lag|stutter|bug|drama|jitter)\b/gi,
  // jauh + komparatif
  /\bjauh\s+(?:dibandingkan|dari|lebih)\b/gi,
  // kurang + angka/nominal
  /\bkurang\s+\d/gi,
  /\bkurang\s+(?:seribu|seratus|sepuluh|sejuta|sepuluh\s+ribu|seratus\s+ribu)\b/gi,

  // ============================================================
  // -- v6 BARU: fix 6 false positive dari audit v5 --
  // ============================================================

  // (1) minim + filler + metric — "minim terasa frame drop",
  //     "minim banget noise", "minim juga lag".
  //     Filler whitelist: terasa, juga, itu, banget, udah, sudah,
  //     agak, cukup. Repeat 0-2 kali.
  /\bminim\s+(?:(?:terasa|juga|itu|banget|udah|sudah|agak|cukup)\s+){0,2}(?:noise|frame\s*drop|lag|stutter|bug|drama|jitter)\b/gi,

  // (2) Reverse pattern: metric + filler + minim.
  //     "noise-nya minim", "noise-nya juga minim", "noise nya itu
  //     minim banget", "frame drop-nya udah minim".
  //     Metric: noise, lag, stutter, jitter, bug, drama, frame drop.
  //     Filler whitelist sama seperti (1).
  /\b(?:noise|lag|stutter|jitter|bug|drama|frame\s*drop)(?:-nya|\s+nya)?\s+(?:(?:itu|juga|terasa|sudah|udah|banget|agak|cukup)\s+){0,2}(?:banget\s+)?minim\b/gi,

  // (3) kurang + cahaya/pencahayaan/lampu/sinar + berbagai bentuk.
  //     Forward: "kurang cahaya", "kurang pencahayaan".
  //     Reverse: "cahayanya kurang", "pencahayaan kurang".
  //     \w* menangkap suffix -nya, -pun, dsb.
  /\bkurang\s+(?:cahaya|pencahayaan|lampu|sinar)\w*\b/gi,
  /\b(?:cahaya|pencahayaan|lampu|sinar)\w*\s+kurang\b/gi,

  // (4) jauh dalam komparasi kuantitatif.
  //     "lumayan jauh sekitar 0,6 mm", "beda lumayan jauh sekitar 0,6 mm",
  //     "agak jauh sekitar 2 cm".
  //     Pattern: (filler)? jauh + (filler)? + angka dalam 20 karakter.
  /\b(?:beda|lumayan|agak|cukup|jauh)\s+(?:lumayan\s+)?jauh\b(?=[^.!?]{0,20}\d)/gi,
  //     Variant kedua: "beda lumayan jauh" tanpa angka langsung.
  /\bbeda\w*\s+lumayan\s+jauh\b/gi,

  // (5) "paling buruk" / "paling jelek" sebagai worst-case quantifier
  //     setelah range angka. Contoh: "40-30 paling buruk".
  //     Pattern: (range angka | angka) + spasi + paling + buruk/jelek
  //     di akhir kalimat atau diikuti tanda baca.
  /\b\d+(?:[-–]\d+)?(?:\s+\w+){0,3}\s+paling\s+(?:buruk|jelek)\b(?=\s*[.,;]|\s*$)/gi,
];

// Discourse markers.
const DISCOURSE_MARKERS: RegExp[] = [
  // discourse "cukup"
  /\bcukup\s+(?:kalian|kamu|anda|kita|sekian|segitu|gitu)\b/gi,
  /(^|[.!?]\s+)cukup\s+[a-z]+\s+(?:kalian|kamu|anda|kita)\b/gi,
  // discourse "oke"
  /(^|[.!?]\s+)oke\s*[,.]/gi,
  /(^|[.!?]\s+)oke\s+(?:kita|kalian|kamu|anda|guys|semua|semuanya|lanjut|sekarang|jadi)\b/gi,

  // -- v6 BARU: discourse framing "yang bagus lagi dulu" --
  // Konteks: reviewer memulai bagian baru dengan menyebut kategori
  // yang akan dibahas ("Pertama kita bahas yang bagus lagi dulu").
  // Ini framing, bukan penilaian produk.
  /\b(?:kita\s+)?bahas\s+yang\s+(?:bagus|jelek|kurang)\b/gi,
  /\byang\s+(?:bagus|jelek|kurang)\s+(?:lagi\s+)?dulu\b/gi,
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ------------------------------------------------------------
// KOMPILASI REGEX
// ------------------------------------------------------------

const CORE_LEXICON = EVALUATIVE_CORE.map(w => ({
  w,
  re: new RegExp(`(^|[^a-z])${escapeRe(w)}([^a-z]|$)`, 'i')
}));

// "cukup" baru menjadi pemicu ketika konteksnya menunjukkan penilaian
// kualitas atau kecukupan hasil/penggunaan.
//
// Sengaja TIDAK mencakup:
// - "cukup melakukan ..."       → instruksi/jumlah tindakan
// - "cukup kalian ..."          → discourse marker
// - "cukup banyak ..."          → kuantitas, bukan penilaian kualitas
//
// Pola dibuat spesifik agar INTENSIFIER tetap bukan leksikon evaluatif global.
const CUKUP_CONTEXT_REGEX =
  /\bcukup\s+(?:(?:stabil|bagus|oke|baik|terang|tajam|jernih|cepat|kencang|lancar|nyaman|memadai|awet|responsif|lengkap)\b|bisa\s+diandalkan\b|untuk\s+(?:seharian|kebutuhan(?:\s+harian)?|pemakaian(?:\s+harian)?|penggunaan(?:\s+harian)?|aktivitas(?:\s+harian)?|dipakai\b)|kalau\s+dipakai\b)/i;

const CONTEXT_LEXICON = CONTEXT_EVALUATIVE.map(w => ({
  w,
  re: new RegExp(`(^|[^a-z])${escapeRe(w)}([^a-z]|$)`, 'i')
}));

const WHITELIST_REGEXES = TECHNICAL_WHITELIST_PHRASES.map(
  p => new RegExp(`(^|[^a-z])${escapeRe(p)}(?=[^a-z]|$)`, 'gi')
);

function discourseReplacer(_m: string, ...rest: unknown[]): string {
  return typeof rest[0] === 'string' ? `${rest[0]} ` : ' ';
}

// ------------------------------------------------------------
// NEUTRALIZE
// ------------------------------------------------------------

function neutralizeForCore(raw: string): string {
  let t = raw;
  for (const re of DISCOURSE_MARKERS) t = t.replace(re, discourseReplacer);
  return t;
}

function neutralizeForContext(raw: string): string {
  let t = raw;
  for (const re of NEUTRAL_IDIOMS) t = t.replace(re, ' ');
  for (const re of WHITELIST_REGEXES) t = t.replace(re, '$1 ');
  for (const re of CONTEXT_NEUTRALIZERS) t = t.replace(re, ' ');
  return t;
}

// ------------------------------------------------------------
// FIND EVALUATIVE
// ------------------------------------------------------------
export function findEvaluativeWords(rawText: string): string[] {
  const hits: string[] = [];

  const coreText = neutralizeForCore(rawText);
  for (const { w, re } of CORE_LEXICON) {
    if (re.test(coreText)) hits.push(w);
  }

  // Tambahan: Deteksi frasa "cukup"
  const cukupMatch = CUKUP_CONTEXT_REGEX.test(coreText);
  if (cukupMatch) {
    hits.push('cukup');
  }

  const contextText = neutralizeForContext(rawText);
  for (const { w, re } of CONTEXT_LEXICON) {
    if (re.test(contextText)) hits.push(w);
  }

  return Array.from(new Set(hits));
}

function hasAssessmentValue(v: string | null | undefined): boolean {
  if (v === null || v === undefined) return false;
  return !NULLISH_ASSESSMENT.has(String(v).trim().toLowerCase());
}

export const AssessmentValidator = {
  validate(
    type: string | undefined,
    reviewerAssessment: string | null | undefined,
    claim?: string | null,
    sourceExcerpt?: string | null
  ): ValidationResult {
    const normalizedType = String(type ?? '').trim().toUpperCase();
    const hasAssessment = hasAssessmentValue(reviewerAssessment);

    // Aturan 0: non-OPINION tidak boleh punya assessment
    if (
      normalizedType !== '' &&
      hasAssessment &&
      !ALLOWED_TYPES_FOR_ASSESSMENT.includes(normalizedType)
    ) {
      return {
        pass: false,
        status: 'FAIL',
        rule: 'ASSESSMENT',
        reason: `${normalizedType} tidak boleh memiliki reviewer_assessment (hanya OPINION yang boleh)`,
        severity: 'HIGH'
      };
    }

    // Aturan 1: OPINION wajib punya assessment
    if (normalizedType === 'OPINION' && !hasAssessment) {
      return {
        pass: false,
        status: 'SUSPECT',
        rule: 'ASSESSMENT',
        reason: 'OPINION wajib memiliki reviewer_assessment',
        severity: 'HIGH'
      };
    }

    // Aturan 1b: type kosong / tidak dikenal
    if (normalizedType === '') {
      return {
        pass: true,
        status: 'SUSPECT',
        rule: 'ASSESSMENT',
        reason: 'Type kosong/tidak dikenal — tidak dapat memverifikasi aturan assessment',
        severity: 'LOW'
      };
    }

    // Aturan 2: non-OPINION tetapi mengandung kata evaluatif.
    if (!ALLOWED_TYPES_FOR_ASSESSMENT.includes(normalizedType)) {
      const claimHits = findEvaluativeWords(claim || '');
      const excerptHits = findEvaluativeWords(sourceExcerpt || '');
      const all = Array.from(new Set([...claimHits, ...excerptHits]));

      if (all.length > 0) {
        // v5/v6: BLOCKING HANYA DARI EXCERPT.
        const excerptBlocks =
          excerptHits.length > 0 && !FLAG_ONLY_TYPES.has(normalizedType);
        const severity: 'HIGH' | 'LOW' = excerptBlocks ? 'HIGH' : 'LOW';
        const triggerSource = excerptBlocks ? excerptHits : all;
        const triggers = triggerSource
          .slice(0, 3)
          .map(w => `"${w}"`)
          .join(', ');

        let reason = excerptBlocks
          ? `Type ${normalizedType} mengandung kata evaluatif pada source_excerpt — kemungkinan salah klasifikasi [kata: ${triggers}]`
          : `Type ${normalizedType} mengandung kata evaluatif — kemungkinan salah klasifikasi [kata: ${triggers}]`;

        if (excerptBlocks) {
          // HIGH: kata evaluatif ditemukan pada sumber literal.
        } else if (excerptHits.length > 0) {
          reason += ' (type flag-only; ditandai saja, tidak memblokir)';
        } else {
          reason += ' (kata hanya di claim; excerpt literal bersih — tidak memblokir)';
        }

        return {
          pass: !excerptBlocks,
          status: 'SUSPECT',
          rule: 'ASSESSMENT',
          reason,
          severity
        };
      }
    }

    return { pass: true, status: 'PASS', rule: 'ASSESSMENT', severity: 'LOW' };
  }
};