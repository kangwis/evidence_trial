// ============================================================
// ANCHOR-BASED PROVENANCE RESOLVER — INTERNAL
// ============================================================
// BUKAN validator keempat. Dipanggil DARI DALAM
// ProvenanceValidator.resolve(). Tidak diekspor ke
// evidence-validator.ts, tidak didaftarkan di validators/index.ts
// sebagai peer Grounding/Provenance.
//
// INVARIANT ARSITEKTUR (direvisi — lihat CHANGELOG SPAN EXPANSION
// di bawah untuk alasan perubahan dari audit ronde 3 sebelumnya):
//
//   1. Candidate set WAJIB berasal dari findSourceMatches().
//      DILARANG membuat matcher/window baru untuk MENENTUKAN
//      candidate span itu sendiri (segmentStartIndex..segmentEndIndex
//      tempat excerpt LITERAL ditemukan tidak pernah berubah).
//
//   2. Anchor comparison memakai normalizer yang sama dengan
//      search.ts (normalizeForSearch). DILARANG membuat normalizer
//      lokal atau alias semantic.
//
//   3. [DIREVISI] Anchor DICOBA LEBIH DULU terhadap teks candidate
//      span itu sendiri (perilaku asli, tidak berubah). HANYA jika
//      TIDAK ADA satu pun kandidat yang didukung pada fase sempit
//      ini (supportedNarrow.length === 0), resolver mencoba fase
//      kedua: mencocokkan anchor terhadap jendela yang diperluas
//      sejauh ANCHOR_EXPANSION_RADIUS segmen ke depan/belakang dari
//      TIAP kandidat secara independen. Koordinat yang dikembalikan
//      SELALU span asli yang sempit (segmentStartIndex..segmentEndIndex
//      dari findSourceMatches) — perluasan HANYA alat bantu
//      disambiguasi anchor, TIDAK PERNAH mengubah lokasi excerpt yang
//      dilaporkan. Kalau fase sempit sudah menghasilkan >1 kandidat
//      (ambigu), fase lebar TIDAK dicoba — melebarkan jendela pada
//      kondisi yang sudah ambigu hanya bisa menambah kecocokan, tidak
//      pernah mengurangi jadi 1.
//
//   4. RESOLVED hanya jika cardinality(candidateSupport) === 1, pada
//      fase manapun ia RESOLVED (sempit atau lebar).
//      Tidak ada fallback "ambil yang pertama/terdekat".
//
// ============================================================
// CHANGELOG — SPAN EXPANSION (audit lanjutan, 13 run produksi)
// ============================================================
// Invariant #3 versi asli (dikunci audit ronde 3) MELARANG TOTAL
// perluasan window, dengan alasan "cross-segment coreference bukan
// tanggung jawab resolver ini". Setelah 13 run produksi berturut-
// turut (45hfkSE5DvA), pola berikut TERBUKTI TIDAK PERNAH bisa
// ter-resolve di bawah invariant lama:
//
//   Segmen 96: "Ini adalah kamera selfie 13 MP, bukaan f/2.2, fixed focus."
//   Segmen 97: "Perekaman videonya up to 1080p 30 fps."
//   Segmen 101: "Kemudian untuk kamera berikutnya ada kamera ultrawide 8 MP, bukaan f/2.2."
//   Segmen 102: "Ini fixed focus juga ya, perekaman videonya up to 1080p 30 fps."
//
// Excerpt "up to 1080p 30 fps" cocok di SEGMEN 97 DAN 102 (dua
// candidate span terpisah, masing-masing 1 segmen). Subtopic anchor
// ("selfie" / "ultrawide") TIDAK PERNAH muncul di span 97 atau span
// 102 itu sendiri — kata pembeda hanya ada di segmen SEBELUMNYA (96
// dan 101). Di bawah invariant lama, KEDUA evidence ini SELALU
// AMBIGUOUS, permanen, tidak peduli seberapa sering diekstraksi ulang.
//
// KEPUTUSAN: melonggarkan invariant #3 dengan cara YANG PALING
// SEMPIT dan TERUKUR yang menutup kasus ini, tanpa membuka celah baru:
//   - Radius kecil dan tetap (1 segmen), bukan tanpa batas. Radius=2
//     sempat dicoba dan JUGA menutup kasus di atas, tapi terbukti
//     membuka false-positive pada fixture yang sama (anchor "macro"
//     salah ter-resolve ke ultrawide lewat segmen 103 yang tidak
//     terkait) -- lihat komentar ANCHOR_EXPANSION_RADIUS di bawah.
//     Radius=1 sudah cukup untuk seluruh kasus produksi nyata tanpa
//     risiko itu.
//   - Hanya FALLBACK setelah fase sempit gagal total (0 kandidat),
//     bukan pengganti fase sempit.
//   - Koordinat hasil TETAP span sempit asli — tidak pernah
//     melaporkan lokasi yang lebih luas dari yang sebenarnya
//     didukung excerpt literal.
//   - cardinality-check (RESOLVED hanya jika tepat 1) tetap berlaku
//     penuh di fase lebar.
//
// Test #4/#5/#6 di anchor-resolver.contract.test.ts (sebelumnya
// tripwire "tidak boleh melebar") SEKARANG diperbarui menjadi
// tripwire SEBALIKNYA: memastikan pelebaran ini BENAR-BENAR
// menyelesaikan pola di atas, dengan radius yang dibatasi dan
// koordinat yang tetap sempit. Lihat catatan di file test.
// ----
// FASE 3 (product-veto, N-01): jika anchor kosong/tidak diskriminatif
// dan caller meneruskan productHint (dari claim/context), kandidat
// disaring berdasarkan produk yang disebut terdekat di transkrip.
// Ini FILTER (boleh mengurangi), bukan ekspansi. Fail-closed: RESOLVED
// hanya bila TEPAT 1 kandidat cocok dan tidak ada kandidat tanpa mention.
// ============================================================

import type {
  EvidenceContext,
  SourceCoordinates,
  SegmentMatch
} from '../types';
import { MAX_VALIDATION_SPAN, findSourceMatches } from '../search';
import { normalizeForSearch, type SRTSegment } from '../srt';

export interface ProvenanceResolution {
  status: ProvenanceResolutionStatus;
  coordinates: SourceCoordinates | null;
  /** Jalur yang menentukan hasil RESOLVED (telemetri). */
  via?: 'single' | 'anchor' | 'product';
}

export type ProvenanceResolutionStatus = 'RESOLVED' | 'AMBIGUOUS';

export interface ProvenanceResolution {
  status: ProvenanceResolutionStatus;
  coordinates: SourceCoordinates | null;
}

// Radius perluasan, dalam satuan segmen SRT, ke depan DAN ke
// belakang dari candidate span. Nilai ini SENGAJA kecil dan
// eksplisit (bukan konstanta tersembunyi di dalam fungsi) supaya
// mudah diaudit dan disesuaikan tanpa membongkar logika resolver.
//
// RADIUS=1 (bukan 2): radius=2 SUDAH DICOBA lebih dulu dan terbukti
// cukup untuk menutup pola produksi (jarak 1 segmen antara kalimat
// deklarasi kamera dan kalimat kapabilitas rekam), TAPI radius=2
// juga terbukti membuka false-positive nyata pada fixture yang SAMA:
// anchor "macro" (ejaan Inggris) dengan excerpt "bukaan f/2.2" salah
// ter-RESOLVED ke segmen 101 (ultrawide), padahal "bukaan f/2.2"
// tidak pernah disebut terkait kamera macro sama sekali -- "macro"
// hanya kebetulan muncul di segmen 103 (kamera macro, topik lain),
// yang masih terjangkau radius=2 dari kandidat 101. Radius=1 menutup
// SEMUA kasus produksi nyata yang sama (#4/#5/#6 di
// anchor-resolver.contract.test.ts) TANPA membuka celah ini, karena
// segmen 103 sudah di luar jangkauan radius=1 dari kandidat 101.
// Kalau di masa depan ditemukan pola nyata yang butuh radius lebih
// besar, naikkan nilai ini SATU per SATU sambil menjalankan ulang
// seluruh contract test -- jangan langsung lompat ke nilai besar.
export const ANCHOR_EXPANSION_RADIUS = 1;

// ------------------------------------------------------------
// HELPER — teks candidate span PERSIS (tanpa perluasan). Dipakai
// untuk fase 1 (sempit) DAN untuk menentukan koordinat akhir yang
// dilaporkan, di kedua fase.
// ------------------------------------------------------------

function getCandidateSpanText(
  candidate: SegmentMatch,
  context: EvidenceContext
): string {
  return context.chunkSegments
    .filter(
      seg =>
        seg.index >= candidate.segmentStartIndex &&
        seg.index <= candidate.segmentEndIndex
    )
    .map(seg => seg.text)
    .join(' ');
}

// ------------------------------------------------------------
// HELPER — teks candidate span DIPERLUAS sejauh `radius` segmen
// ke depan/belakang. HANYA dipakai untuk mencocokkan anchor di
// fase 2 (lebar). TIDAK PERNAH dipakai untuk candidateToCoordinates
// — koordinat yang dilaporkan selalu dari getCandidateSpanText
// (span sempit asli).
// ------------------------------------------------------------

function getExpandedSpanText(
  candidate: SegmentMatch,
  context: EvidenceContext,
  radius: number
): string {
  const lowerBound = candidate.segmentStartIndex - radius;
  const upperBound = candidate.segmentEndIndex + radius;
  return context.chunkSegments
    .filter(seg => seg.index >= lowerBound && seg.index <= upperBound)
    .map(seg => seg.text)
    .join(' ');
}

function candidateToCoordinates(
  candidate: SegmentMatch,
  context: EvidenceContext
): SourceCoordinates {
  return {
    chunk_index: context.chunkIndex,
    segment_start_index: candidate.segmentStartIndex,
    segment_end_index: candidate.segmentEndIndex,
    char_start: null,
    char_end: null
  };
}

// ------------------------------------------------------------
// HELPER — cek anchor vs satu span text, dengan batas kata (bukan
// substring bebas). Dipakai di kedua fase.
// ------------------------------------------------------------

function anchorSupportsSpan(normalizedAnchor: string, spanText: string): boolean {
  const normalizedSpan = normalizeForSearch(spanText);
  return (` ${normalizedSpan} `).includes(` ${normalizedAnchor} `);
}

// ------------------------------------------------------------
// FASE 3 — PRODUCT-VETO
// ------------------------------------------------------------
export interface AnchorResolverOptions {
  /** Teks claim/context yang memuat produk, mis. "Samsung Galaxy A18 5G". */
  productHint?: string | null;
}

interface ProductSignal {
  model: string;           // "A18", "A07S"
  variant: string | null;  // "4G" | "5G" | "LTE" | "WIFI"
}

// Varian dicari 30 karakter setelah model, termasuk awal segmen berikutnya
// (lookahead): "…Galaxy A07" / "yang 5G-nya." (seg 69-70 di data produksi).
function extractProductSignals(text: string, lookahead = ''): ProductSignal[] {
  const out: ProductSignal[] = [];
  const combined = text + lookahead;
  const re = /\bgalaxy\s+(a\d{2}s?)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length;
    const v = combined.slice(end, end + 30).match(/\b(4G|5G|LTE|Wi-?Fi)\b/i);
    out.push({
      model: m[1].toUpperCase(),
      variant: v ? v[1].toUpperCase().replace('WI-FI', 'WIFI') : null
    });
  }
  return out;
}

function buildMentionIndex(
  segs: SRTSegment[]
): Array<{ index: number; sig: ProductSignal }> {
  const sorted = [...segs].sort((a, b) => a.index - b.index);
  const out: Array<{ index: number; sig: ProductSignal }> = [];
  for (let i = 0; i < sorted.length; i++) {
    const seg = sorted[i];
    const next = sorted[i + 1];
    const lookahead = next && next.index === seg.index + 1 ? ' ' + next.text : '';
    const sigs = extractProductSignals(seg.text, lookahead);
    if (sigs.length > 0) out.push({ index: seg.index, sig: sigs[sigs.length - 1] });
  }
  return out;
}

function productsMatch(hint: ProductSignal, m: ProductSignal): boolean {
  if (hint.model !== m.model) return false;
  // Varian hanya menolak bila KEDUANYA terisi dan berbeda (weak match
  // bila salah satu null; multi-match tetap berujung AMBIGUOUS).
  return !(hint.variant && m.variant) || hint.variant === m.variant;
}

type ProductVetoReason =
  | 'OK' | 'NO_HINT' | 'MIXED_HINT'
  | 'UNKNOWN_MENTION' | 'NO_MATCH' | 'MULTI_MATCH';

interface ProductVetoOutcome {
  hit: SegmentMatch | null;
  reason: ProductVetoReason;
  perCandidate: string[];
}

function evaluateProductVeto(
  pool: SegmentMatch[],
  hintText: string,
  context: EvidenceContext
): ProductVetoOutcome {
  const hints = extractProductSignals(hintText);
  if (hints.length === 0) return { hit: null, reason: 'NO_HINT', perCandidate: [] };

  const models = new Set(hints.map(h => h.model));
  const variants = new Set(hints.map(h => h.variant).filter((v): v is string => !!v));
  // Klaim perbandingan (dua model) atau dua varian: tidak menebak.
  if (models.size !== 1 || variants.size > 1) {
    return { hit: null, reason: 'MIXED_HINT', perCandidate: [] };
  }
  const hint: ProductSignal = { model: hints[0].model, variant: [...variants][0] ?? null };

  // Mention dicari di SELURUH video bila tersedia; kandidat tetap dari chunk.
  const index = buildMentionIndex(context.allSegments ?? context.chunkSegments);

  const matched: SegmentMatch[] = [];
  const perCandidate: string[] = [];
  let unknown = false;

  for (const c of pool) {
    let mention: { index: number; sig: ProductSignal } | null = null;
    for (let i = index.length - 1; i >= 0; i--) {
      if (index[i].index <= c.segmentEndIndex) { mention = index[i]; break; }
    }
    const span = c.segmentStartIndex === c.segmentEndIndex
      ? `${c.segmentStartIndex}`
      : `${c.segmentStartIndex}-${c.segmentEndIndex}`;
    if (!mention) {
      unknown = true;
      perCandidate.push(`${span}: tanpa mention`);
      continue;
    }
    perCandidate.push(
      `${span}: ${mention.sig.model}${mention.sig.variant ? '/' + mention.sig.variant : ''}@seg${mention.index}`
    );
    if (productsMatch(hint, mention.sig)) matched.push(c);
  }

  // Kandidat tanpa mention = TIDAK DIKETAHUI, bukan "tidak cocok".
  if (unknown) return { hit: null, reason: 'UNKNOWN_MENTION', perCandidate };
  if (matched.length === 0) return { hit: null, reason: 'NO_MATCH', perCandidate };
  if (matched.length > 1) return { hit: null, reason: 'MULTI_MATCH', perCandidate };
  return { hit: matched[0], reason: 'OK', perCandidate };
}

/** Hint dari claim; jika claim tak memuat model, pakai context. */
export function selectProductHint(
  claim: string | null | undefined,
  evContext: string | null | undefined
): string | null {
  for (const s of [claim, evContext]) {
    if (typeof s === 'string' && extractProductSignals(s).length > 0) return s;
  }
  return null;
}

/** Diagnostik untuk scripts/ambiguous-report.ts. */
export function diagnoseProductVeto(
  pool: SegmentMatch[],
  hintText: string,
  context: EvidenceContext
): { reason: ProductVetoReason; perCandidate: string[] } {
  const { reason, perCandidate } = evaluateProductVeto(pool, hintText, context);
  return { reason, perCandidate };
}

// ------------------------------------------------------------
// resolveProvenanceAnchor()
// ------------------------------------------------------------
export function resolveProvenanceAnchor(
  sourceExcerpt: string | null | undefined,
  anchor: string | null | undefined,
  context: EvidenceContext,
  options: AnchorResolverOptions = {}
): ProvenanceResolution {
  const AMBIGUOUS: ProvenanceResolution = { status: 'AMBIGUOUS', coordinates: null };

  const candidates = findSourceMatches(sourceExcerpt, context, {
    maxSpan: MAX_VALIDATION_SPAN
  });

  if (candidates.length === 0) return AMBIGUOUS;

  if (candidates.length === 1) {
    return {
      status: 'RESOLVED',
      coordinates: candidateToCoordinates(candidates[0], context),
      via: 'single'
    };
  }

  const byProduct = (pool: SegmentMatch[]): ProvenanceResolution | null => {
    if (!options.productHint) return null;
    const { hit } = evaluateProductVeto(pool, options.productHint, context);
    return hit
      ? {
          status: 'RESOLVED',
          coordinates: candidateToCoordinates(hit, context),
          via: 'product'
        }
      : null;
  };

  const normalizedAnchor = normalizeForSearch(anchor || '');

  // Tanpa anchor: satu-satunya pembeda yang tersisa adalah produk.
  if (!normalizedAnchor) return byProduct(candidates) ?? AMBIGUOUS;

  // ---- FASE 1: sempit ----
  const supportedNarrow = candidates.filter(candidate =>
    anchorSupportsSpan(normalizedAnchor, getCandidateSpanText(candidate, context))
  );

  if (supportedNarrow.length === 1) {
    return {
      status: 'RESOLVED',
      coordinates: candidateToCoordinates(supportedNarrow[0], context),
      via: 'anchor'
    };
  }

  if (supportedNarrow.length > 1) {
    // Ekspansi (fase 2) tidak bisa mengurangi; FILTER produk bisa.
    return byProduct(supportedNarrow) ?? AMBIGUOUS;
  }

  // ---- FASE 2: lebar (hanya bila fase 1 = 0) ----
  const supportedWide = candidates.filter(candidate =>
    anchorSupportsSpan(
      normalizedAnchor,
      getExpandedSpanText(candidate, context, ANCHOR_EXPANSION_RADIUS)
    )
  );

  if (supportedWide.length === 1) {
    // Koordinat tetap span SEMPIT asli.
    return {
      status: 'RESOLVED',
      coordinates: candidateToCoordinates(supportedWide[0], context),
      via: 'anchor'
    };
  }

  // >1: saring dalam himpunan yang didukung anchor; 0: anchor tak berguna.
  return byProduct(supportedWide.length > 1 ? supportedWide : candidates) ?? AMBIGUOUS;
}
