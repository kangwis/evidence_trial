// ============================================================
// TEXT MATCHING — SHARED SURFACE-TEXT NORMALIZATION PRIMITIVE
// ============================================================
// Single source of truth untuk normalizeForMatching() dan wrapper
// containment-nya. Dipindah dari reproducibility-harness.ts (riset)
// supaya modul production (duplicate.ts, dst.) memakai primitive
// normalisasi YANG SAMA PERSIS dengan yang dipakai mengukur
// reproducibility E.3D -- mencegah drift riset vs production.
//
// BUKAN bagian dari production-pipeline.ts (SRT parsing, chunking,
// evidence JSON parsing, prompt builder) -- text matching adalah
// concern independen, konsisten dengan pola srt.ts/types.ts yang
// sudah terpisah di codebase ini. Lihat rangkuman-audit-shared-
// predicate-duplicate-split.md bagian 5 untuk konteks keputusan.
//
// PERILAKU TIDAK BERUBAH dari implementasi asli di
// reproducibility-harness.ts -- ini PEMINDAHAN, bukan rewrite.
//
// ============================================================
// ⚠️ PENTING — DUA NORMALIZER DI CODEBASE INI
// ============================================================
// Codebase ini punya DUA normalizer berbeda dengan tujuan berbeda.
// JANGAN mencampur keduanya dalam satu keputusan.
//
// 1. normalizeForSearch (src/evidence/srt.ts)
//    Tujuan : mencari source_excerpt di dalam teks SRT.
//    Sifat  : AGRESIF. Membuang semua tanda baca umum
//             (`. , ! ? ; : ( ) [ ] { }`), quote (' " `),
//             dan mengubah dash/underscore jadi spasi.
//    Case   : toLowerCase() (locale-agnostic).
//    Contoh : "Victus+"    -> "victus+"
//             "8/256"      -> "8/256"     (slash dipertahankan)
//             "Layar: 6.7" -> "layar 6 7" (titik & titik dua hilang)
//
// 2. normalizeForMatching (file ini)
//    Tujuan : membandingkan teks permukaan dengan vocab terkontrol
//             (subtopic) atau proposition matching.
//    Sifat  : KONSERVATIF. Hanya menyeragamkan NBSP, quote unicode,
//             dash/underscore, collapse whitespace, dan trailing
//             period TUNGGAL (bukan ellipsis). Tanda baca lain
//             TETAP ADA.
//    Case   : toLocaleLowerCase('id-ID') (locale-aware).
//    Contoh : "Victus+"    -> "victus+"   (sama dengan search)
//             "8/256"      -> "8/256"     (sama)
//             "Layar: 6.7" -> "layar: 6.7" (TIDAK sama — search
//                                          membuang `:`, yang di sini
//                                          dipertahankan)
//
// ALASAN dipisah: normalizeForSearch menyelesaikan masalah "apakah
// excerpt KUTIPAN yang ditemukan di sumber?" -- melonggarkan tanda
// baca meningkatkan recall. normalizeForMatching menyelesaikan
// masalah "apakah DUA TEKS yang sudah kanonik ini sama?" --
// memperketat tanda baca mencegah false-equal.
//
// KAPAN PAKAI YANG MANA:
//   - Mencari excerpt di SRT           -> normalizeForSearch
//   - Membandingkan subtopic/attribute -> normalizeForMatching
//   - Membandingkan claim/context bebas -> normalizeForSearch
//   - Proposition matching (harness)   -> normalizeForMatching
// ============================================================
//
// Spesifikasi 8-step (NBSP, unicode quote tunggal, unicode quote
// ganda, trim, dash/underscore -> spasi, collapse whitespace,
// case-fold id-ID, strip trailing '.' non-ellipsis, trim ulang).
// Sudah terkunci lewat 14 self-test assertion yang tetap berjalan
// di harness.
//
// CATATAN — ELLIPSIS TIDAK DINORMALISASI (sengaja):
// normalizeForMatching TIDAK menyentuh `...` (triple ASCII dot)
// maupun `…` (unicode ellipsis). Keduanya dianggap berbeda oleh
// normalizer ini. Alasan:
//   1. Ellipsis adalah sinyal "fragmen non-kontinu" -- excerpt
//      yang menggabungkan potongan yang tidak berurutan di sumber.
//      Menormalkannya akan MENYEMBUNYIKAN sinyal ini.
//   2. Deteksi ellipsis ditangani secara terpisah oleh
//      excerptContainsEllipsis() di src/evidence/search.ts, yang
//      dipakai Grounding/Provenance untuk reason FAIL yang lebih
//      informatif.
//   3. Untuk perbandingan vocab terkontrol (subtopic), ellipsis
//      tidak mungkin muncul.
// JANGAN menambahkan normalisasi ellipsis tanpa meninjau ulang
// konsumen di harness reproducibility (14 self-test assertion).
//
// CATATAN — CAKUPAN UNICODE QUOTE:
// Hanya quote kiri/kanan standar (U+2018/2019, U+201C/201D) yang
// dikonversi ke straight quote. Quote low-9 (U+201A/201E) dan
// prime (U+2032/2033) sengaja TIDAK ditangani karena tidak muncul
// di subtitle Bahasa Indonesia. Kalau muncul di masa depan (mis.
// auto-translate Eropa), tambahkan secara eksplisit di sini.
// ============================================================

export function normalizeForMatching(text: string): string {
  if (typeof text !== 'string') return '';

  let result = text;

  // Step 1 — NBSP -> spasi biasa
  result = result.replace(/\u00A0/g, ' ');
  // Step 2 — unicode single quote -> straight
  result = result.replace(/[\u2018\u2019]/g, "'");
  // Step 3 — unicode double quote -> straight
  result = result.replace(/[\u201C\u201D]/g, '"');
  // Step 4 — trim awal/akhir
  result = result.trim();
  // Step 5 — dash & underscore -> spasi
  result = result.replace(/[-–—_]/g, ' ');
  // Step 6 — collapse whitespace
  result = result.replace(/\s+/g, ' ');
  // Step 7 — case-fold locale Indonesia
  result = result.toLocaleLowerCase('id-ID');

  // Step 8 — strip trailing period TUNGGAL (bukan ellipsis)
  //   "."  -> ""
  //   "hi." -> "hi"
  //   "hi.." -> "hi.." (dianggap ellipsis parsial, dipertahankan)
  //   "..." -> "..." (ellipsis, dipertahankan)
  if (result.length === 1 && result === '.') {
    result = '';
  } else if (
    result.length >= 2 &&
    result.endsWith('.') &&
    result[result.length - 2] !== '.'
  ) {
    result = result.slice(0, -1);
  }

  // Trim ulang setelah strip period
  result = result.replace(/\s+$/, '');

  return result;
}

/** needle = proposition, haystack = excerpt (riset: validateRequiredPropositions) */
export function propositionMatchesExcerpt(proposition: string, excerpt: string): boolean {
  return normalizeForMatching(excerpt).includes(normalizeForMatching(proposition));
}

/** needle = excerpt, haystack = chunkText (riset: validateLiteralExcerpt) */
export function excerptMatchesChunk(excerpt: string, chunkText: string): boolean {
  return normalizeForMatching(chunkText).includes(normalizeForMatching(excerpt));
}

/** Containment generik, tanpa asumsi arah needle/haystack tertentu. */
export function containsNormalized(needle: string, haystack: string): boolean {
  return normalizeForMatching(haystack).includes(normalizeForMatching(needle));
}

/** Kesetaraan penuh pasca-normalisasi -- untuk field bervocab terkontrol (mis. subtopic). */
export function equalsNormalized(a: string, b: string): boolean {
  return normalizeForMatching(a) === normalizeForMatching(b);
}

// ============================================================
// QUASI-LITERAL MATCHING — fallback untuk excerpt yang tidak
// persis literal tapi mempertahankan kata bermakna + urutan.
// ============================================================
// Kontrak (lihat grounding.ts/provenance.ts):
//   - Kata bermakna wajib ada di chunk, dalam URUTAN ASLI.
//   - Kata fungsi / imbuhan / ejaan boleh berbeda.
//   - Kata bermakna BARU (tidak ada di chunk) = FAIL.
//
// Tidak menggantikan normalizeForSearch (exact path). Ini tier-2
// yang dipanggil HANYA setelah exact gagal.
// ============================================================

/**
 * Function words Bahasa Indonesia: partikel, konjungsi, pronomina,
 * preposisi, kata bantu, relativizer. Tidak dianggap bermakna.
 * SENGAJA tidak memuat: sangat, agak, cukup, banget, tidak, bukan,
 * bisa, dapat, ada, karena kata-kata ini sering menjadi sinyal
 * evaluatif/negasi yang penting.
 */
export const FUNCTION_WORDS_ID: ReadonlySet<string> = new Set([
  // partikel
  'ya','sih','nih','tuh','deh','kok','dong','kan','lah','kah','pun',
  // konjungsi
  'dan','atau','tapi','tetapi','namun','juga','terus','lalu','jadi','nah','oke','ok',
  // pronomina / deiksis
  'kita','kami','dia','itu','ini','mereka','saya','gue','aku','kamu','kalian',
  // preposisi
  'di','ke','dari','pada','untuk','dengan','saat','se','sebagai','buat','dalam','oleh',
  // kata bantu / temporal
  'sudah','udah','telah','masih','akan','telah',
  // relativizer + posesif + artikel
  'yang','nya','sebuah','para','suatu',
]);

/**
 * Strip imbuhan umum Bahasa Indonesia (prefix + suffix, bukan
 * circumfix). Setiap strip hanya dilakukan jika sisa ≥4 karakter.
 */
export function stripIndonesianAffixes(w: string): string {
  let s = w;
  // suffix dulu (dari terpanjang)
  for (const suf of ['kannya','annya','nya','lah','kan','an','i']) {
    if (s.endsWith(suf) && s.length - suf.length >= 4) {
      s = s.slice(0, -suf.length);
      break;
    }
  }
  // lalu prefix
  for (const pre of ['meng','meny','mem','men','me','di','ter','ber','per','pe','ke','se']) {
    if (s.startsWith(pre) && s.length - pre.length >= 4) {
      s = s.slice(pre.length);
      break;
    }
  }
  return s;
}

/** Levenshtein distance — untuk toleransi ejaan. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Dua kata dianggap setara bila:
 *   1. Sama persis, ATAU
 *   2. Sama setelah strip imbuhan, ATAU
 *   3. Edit distance ≤ toleransi (panjang-dependent).
 *
 * Toleransi: 4-5 char = 0; 6-8 char = 1; ≥9 char = 2.
 * Kalibrasi: "keliatan"(8)/"kelihatan"(9) → dist 1 ✓
 *            "pasas"(5)/"kapasitas"(9)      → dist 4 ✗
 *            "widevine"(8)/"wideband"(8)    → dist 3 ✗
 */
export function tokensAreEquivalent(a: string, b: string): boolean {
  if (a === b) return true;

  // Cek 1: Levenshtein pada bentuk ASLI (toleransi berbasis panjang asli)
  const nOrig = Math.max(a.length, b.length);
  if (nOrig >= 4) {
    const tolOrig = nOrig <= 5 ? 0 : nOrig <= 8 ? 1 : 2;
    if (levenshtein(a, b) <= tolOrig) return true;
  }

  // Cek 2: kesamaan setelah strip imbuhan (toleransi minimum 1)
  const sa = stripIndonesianAffixes(a);
  const sb = stripIndonesianAffixes(b);
  if (sa === sb) return true;
  const nStrip = Math.max(sa.length, sb.length);
  if (nStrip < 4) return false;
  const tolStrip = nStrip <= 5 ? 1 : nStrip <= 8 ? 1 : 2;
  return levenshtein(sa, sb) <= tolStrip;
}

/**
 * Ekstrak kata bermakna dari teks (lowercase, strip punctuation).
 * Aturan: alfa murni → panjang ≥4; murni angka → ≥2; campuran → ≥2.
 * Function word di-drop.
 */
export function extractMeaningfulTokens(text: string): string[] {
  if (!text) return [];
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9à-ÿ]+/gi, ' ');
  const raw = cleaned.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const t of raw) {
    if (FUNCTION_WORDS_ID.has(t)) continue;
    const hasDigit = /\d/.test(t);
    const hasLetter = /[a-zà-ÿ]/.test(t);
    if (hasLetter && !hasDigit && t.length < 4) continue; // alfa murni pendek
    if (!hasLetter && t.length < 2) continue;             // angka tunggal
    if (hasLetter && hasDigit && t.length < 2) continue;  // campuran pendek
    out.push(t);
  }
  return out;
}

export interface QuasiLiteralResult {
  matches: boolean;
  coverage: number;
  excerptTokens: string[];
  missingTokens: string[];
  segmentStartIndex: number;
  segmentEndIndex: number;
  spanInSegments: number;
}

/**
 * Cari urutan kata bermakna excerpt di dalam segmen-segmen chunk.
 * Urutan asli dijaga. Setiap kata excerpt wajib ketemu (coverage=1).
 * Mengembalikan posisi segmen + span (dalam satuan segmen).
 */
export function matchQuasiLiteralInSegments(
  excerpt: string,
  segments: Array<{ index: number; text: string }>
): QuasiLiteralResult {
  const empty: QuasiLiteralResult = {
    matches: false, coverage: 0, excerptTokens: [], missingTokens: [],
    segmentStartIndex: -1, segmentEndIndex: -1, spanInSegments: 0,
  };

  if (!excerpt) return empty;

  const excerptTokens = extractMeaningfulTokens(excerpt);
  if (excerptTokens.length < 2) return empty;

  interface FlatToken { token: string; segArrayIdx: number; segIndex: number; }
  const flatTokens: FlatToken[] = [];
  segments.forEach((seg, i) => {
    for (const t of extractMeaningfulTokens(seg.text)) {
      flatTokens.push({ token: t, segArrayIdx: i, segIndex: seg.index });
    }
  });

  // Strategi: coba SETIAP kemungkinan start (posisi token pertama di
  // excerpt), lalu cari match terpendek. Ini menghindari jebakan
  // "greedy first match" di mana token pertama match terlalu awal.
  let best: QuasiLiteralResult | null = null;

  for (let startIdx = 0; startIdx < flatTokens.length; startIdx++) {
    const firstFt = flatTokens[startIdx];
    if (!tokensAreEquivalent(excerptTokens[0], firstFt.token)) continue;

    const startSegArrayIdx = firstFt.segArrayIdx;
    let cursor = startIdx + 1;
    let lastSegArrayIdx = startSegArrayIdx;
    let lastSegIndex = firstFt.segIndex;
    let allMatched = true;

    for (let j = 1; j < excerptTokens.length; j++) {
      let found = false;
      while (cursor < flatTokens.length) {
        const ft = flatTokens[cursor];
        if (tokensAreEquivalent(excerptTokens[j], ft.token)) {
          lastSegArrayIdx = ft.segArrayIdx;
          lastSegIndex = ft.segIndex;
          cursor++;
          found = true;
          break;
        }
        cursor++;
      }
      if (!found) { allMatched = false; break; }
    }

    if (allMatched) {
      const span = lastSegArrayIdx - startSegArrayIdx + 1;
      if (!best || span < best.spanInSegments) {
        best = {
          matches: true,
          coverage: 1,
          excerptTokens,
          missingTokens: [],
          segmentStartIndex: firstFt.segIndex,
          segmentEndIndex: lastSegIndex,
          spanInSegments: span,
        };
      }
    }
  }

  if (best) return best;

  // Tidak ada match lengkap — diagnostik: hitung token yang hilang
  // dengan mencoba start paling awal yang mungkin.
  const missingSet = new Set<string>();
  let anyStart = false;
  for (let startIdx = 0; startIdx < flatTokens.length; startIdx++) {
    if (!tokensAreEquivalent(excerptTokens[0], flatTokens[startIdx].token)) continue;
    anyStart = true;
    let cursor = startIdx + 1;
    for (let j = 1; j < excerptTokens.length; j++) {
      let found = false;
      while (cursor < flatTokens.length) {
        if (tokensAreEquivalent(excerptTokens[j], flatTokens[cursor].token)) {
          cursor++;
          found = true;
          break;
        }
        cursor++;
      }
      if (!found) missingSet.add(excerptTokens[j]);
    }
    break; // hanya pakai start pertama untuk diagnostik
  }

  return {
    matches: false,
    coverage: anyStart ? (excerptTokens.length - missingSet.size) / excerptTokens.length : 0,
    excerptTokens,
    missingTokens: [...missingSet],
    segmentStartIndex: -1,
    segmentEndIndex: -1,
    spanInSegments: 0,
  };
}