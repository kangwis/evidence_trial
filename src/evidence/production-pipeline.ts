// ============================================================
// PRODUCTION PIPELINE — SHARED CORE
// ============================================================
// SINGLE SOURCE OF TRUTH untuk:
//   - SRT parsing
//   - Evidence chunking (buildEvidenceChunks, buildChunkText)
//   - Evidence JSON parsing (production strategy, 4-tier fallback)
//   - Identity / metadata context construction
//   - Evidence extraction prompt instruction builder
//
// ATURAN:
// server.ts (production) DAN reproducibility-harness.ts (E.3D)
// WAJIB mengimpor fungsi-fungsi ini dari file ini.
// JANGAN duplikasi implementasi di tempat lain.
//
// Jika production berubah (mis. algoritma chunking, aturan
// fallback JSON parser, atau cara membangun identity context),
// perubahan hanya dilakukan DI SINI — dan otomatis berlaku
// untuk production maupun reproducibility harness.
//
// CHANGELOG:
//   - normalizeNullishFields: tambah handling `related_evidence_ids`
//     (array nullable). Sebelumnya field ini tidak disentuh, sehingga
//     string "null"/"none"/"" dari model bisa lolos ke remapRelatedIds
//     dan mengganggu pemetaan. Sekarang:
//       string nullish -> null
//       array           -> dibiarkan (termasuk array kosong [])
//       string lain     -> dibiarkan (remapRelatedIds punya handling sendiri)
// ============================================================

import { ANALYSIS_PROMPT_EVIDENCE } from '../../prompts';
import type { SRTSegment } from './srt';
import type { EvidenceItem } from './types';

export interface ReviewMetadata {
  id?: string;
  url?: string;
  title?: string;
  channel?: string;
  thumbnail?: string;
  duration?: string;
  views?: number;
  uploadDate?: string;
  commentCount?: number;
  [key: string]: any;
}

// ============================================================
// SRT PARSER
// ============================================================

export function parseSRT(srtContent: string): SRTSegment[] {
  const segments: SRTSegment[] = [];

  const normalized = srtContent
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();

  const blocks = normalized.split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block.split('\n');

    if (lines.length < 3) continue;

    const timeMatch = lines[1].match(
      /(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/
    );

    if (!timeMatch) continue;

    const parsedIndex = Number.parseInt(lines[0].trim(), 10);
    const index = Number.isFinite(parsedIndex)
      ? parsedIndex
      : segments.length + 1;

    const text = lines
      .slice(2)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text) continue;

    segments.push({
      index,
      start: timeMatch[1],
      end: timeMatch[2],
      text
    });
  }

  return segments;
}

// ============================================================
// CHUNKING
// ============================================================

export function buildEvidenceChunks(
  segments: SRTSegment[],
  targetCharacters = 18000,
  overlapSegments = 3
): SRTSegment[][] {
  const chunks: SRTSegment[][] = [];

  if (segments.length === 0) {
    return chunks;
  }

  let startIndex = 0;

  while (startIndex < segments.length) {
    const chunk: SRTSegment[] = [];
    let currentCharacters = 0;
    let cursor = startIndex;

    while (cursor < segments.length) {
      const segment = segments[cursor];
      const segmentSize = segment.text.length + 40;

      if (
        chunk.length > 0 &&
        currentCharacters + segmentSize > targetCharacters
      ) {
        break;
      }

      chunk.push(segment);
      currentCharacters += segmentSize;
      cursor++;

      if (chunk.length === 1 && segmentSize > targetCharacters) {
        break;
      }
    }

    if (chunk.length === 0) {
      break;
    }

    chunks.push(chunk);

    if (cursor >= segments.length) {
      break;
    }

    startIndex = Math.max(cursor - overlapSegments, startIndex + 1);
  }

  return chunks;
}

// production-pipeline.ts
// ============================================================
// CHUNK TEXT — dengan penanda segmen [N]
// ============================================================
// Sejak Opsi B, chunk text yang dikirim ke LLM memuat penanda [N]
// di awal setiap segmen SRT, di mana N adalah segment.index.
//
// Tujuan: memberi tahu LLM di mana batas SRT, supaya excerpt yang
// dihasilkan tidak melintasi >1 SRT.
//
// CATATAN:
// - Penanda [N] BUKAN bagian dari teks sumber.
// - Search (findSourceMatches) tetap memakai context.chunkSegments,
//   bukan chunkText, jadi penanda ini tidak mengganggu matching.
// - Kalau LLM menulis [N] di source_excerpt, stripSegmentMarkers()
//   di search.ts akan membersihkannya sebelum matching.
export function buildChunkText(chunk: SRTSegment[]): string {
  return chunk
    .map(segment => `[${segment.index}] ${segment.text}`)
    .join('\n');
}

// ============================================================
// EVIDENCE JSON PARSER — production strategy (4-tier fallback)
// ============================================================
// Satu core implementation. `parseEvidenceJSON` (dipakai production,
// signature tidak berubah) dan `parseEvidenceJSONDetailed` (dipakai
// harness untuk keperluan diagnostic/reproducibility artifact)
// SAMA-SAMA memanggil core yang sama, sehingga tidak mungkin
// tertinggal sinkron satu sama lain.

type ParseStrategy =
  | 'direct_array'
  | 'direct_object'
  | 'fenced'
  | 'evidence_key_scan'
  | 'array_bracket_scan'
  | 'object_salvage'
  | null;

// Statistik penyelamatan (hanya ada bila strategi 'object_salvage' dipakai).
export interface SalvageStats {
  recovered: number;   // objek evidence yang berhasil diselamatkan
  repaired: number;    // dari recovered: berhasil setelah perbaikan kunci
  skipped: number;     // objek yang tidak bisa diselamatkan (dilewati)
  truncated: boolean;  // objek terakhir tidak lengkap (output terpotong)
}

export interface EvidenceIdMetadata {
  position: number;
  /**
   * Asal ID:
   * - 'model': model menulis evidence_id di JSON
   * - 'auto-fill': parser mengisi karena kosong
   * - 'invalid': item bukan objek, tidak bisa diisi
   */
  source: 'model' | 'auto-fill' | 'invalid';
  originalId: string | null;
}

function parseEvidenceJSONCore(rawOutput: string): {
  evidence: any[];
  strategy: ParseStrategy;
  salvage?: SalvageStats;
} {
  const raw = rawOutput.replace(/^\uFEFF/, '').trim();

  try {
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      return { evidence: parsed, strategy: 'direct_array' };
    }

    if (parsed && Array.isArray(parsed.evidence)) {
      return { evidence: parsed.evidence, strategy: 'direct_object' };
    }
  } catch (_) {}

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);

  if (fenced?.[1]) {
    try {
      const parsed = JSON.parse(fenced[1].trim());

      if (Array.isArray(parsed)) {
        return { evidence: parsed, strategy: 'fenced' };
      }

      if (parsed && Array.isArray(parsed.evidence)) {
        return { evidence: parsed.evidence, strategy: 'fenced' };
      }
    } catch (_) {}
  }

  const evidenceIndex = raw.indexOf('"evidence"');

  if (evidenceIndex !== -1) {
    const objectStart = raw.lastIndexOf('{', evidenceIndex);

    if (objectStart !== -1) {
      try {
        const parsed = JSON.parse(raw.substring(objectStart));

        if (parsed && Array.isArray(parsed.evidence)) {
          return { evidence: parsed.evidence, strategy: 'evidence_key_scan' };
        }
      } catch (_) {}
    }
  }

  const arrayStart = raw.indexOf('[');
  const arrayEnd = raw.lastIndexOf(']');

  if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
    try {
      const parsed = JSON.parse(raw.substring(arrayStart, arrayEnd + 1));

      if (Array.isArray(parsed)) {
        return { evidence: parsed, strategy: 'array_bracket_scan' };
      }
    } catch (_) {}
  }

  // Tier 5 (HANYA bila keempat strategi di atas gagal): selamatkan objek
  // evidence satu per satu. Satu objek rusak atau output terpotong tidak lagi
  // menghilangkan seluruh chunk. Output yang sebelumnya sukses diparse TIDAK
  // pernah sampai ke sini, jadi perilakunya tidak berubah.
  const salvaged = salvageEvidenceObjects(raw);

  if (salvaged && salvaged.evidence.length > 0) {
    return {
      evidence: salvaged.evidence,
      strategy: 'object_salvage',
      salvage: salvaged.stats
    };
  }

  return { evidence: [], strategy: null };
}

// ============================================================
// SALVAGE — penyelamatan objek evidence satu per satu
// ============================================================
// Kasus nyata (video 07DQ9c6-KxA, 3 dari 6 chunk): model sesekali menulis
// kunci TANPA tanda kutip berawalan "_" di akhir item, mis.
//   _comment: "Chipset Exynos 1380",
//   _related_evidence_ids: null
// JSON.parse menolak seluruh respons ("Expected double-quoted property
// name"), sehingga 40+ item hilang karena satu kunci rusak.

const KNOWN_EVIDENCE_FIELDS = new Set([
  'evidence_id', 'topic', 'subtopic', 'type', 'claim', 'value', 'unit',
  'attribute', 'attribute_value', 'context', 'comparison_target',
  'related_evidence_ids', 'reviewer_assessment', 'certainty',
  'timestamp_start', 'timestamp_end', 'source_excerpt', 'source'
]);

// Beri tanda kutip pada kunci tanpa kutip, baik di awal baris MAUPUN
// di tengah baris setelah comma. Model (khususnya Gemini Flash) kadang
// mengeluarkan format "value": null, unit: null, di mana "unit" tidak
// di-quote. Pola ini lolos dari regex line-start original.
//
// Implementasi string-aware: walk karakter, hanya repair saat di luar
// string JSON. Aman untuk content yang memuat ": " atau ", unit" di
// dalam source_excerpt/claim.
function repairUnquotedKeys(objectText: string): string {
  // Step 1: unquoted keys di awal baris (perilaku original)
  let text = objectText.replace(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/gm, '$1"$2"$3');

  // Step 2: unquoted keys setelah '{' atau ',' di tengah baris.
  // Gunakan state machine agar tidak merusak content string.
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }

    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }

    if (ch === '{' || ch === ',') {
      out += ch;
      // Look ahead untuk unquoted identifier + colon
      const rest = text.slice(i + 1);
      const m = rest.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/);
      if (m) {
        out += m[1] + '"' + m[2] + '"' + m[3];
        i += 1 + m[1].length + m[2].length + m[3].length - 1;
        continue;
      }
      continue;
    }

    out += ch;
  }

  return out;
}

// Kunci berawalan "_": bila nama tanpa "_" adalah field evidence yang dikenal
// dan field itu kosong, pulihkan nilainya ("_related_evidence_ids" ->
// "related_evidence_ids"); selain itu (mis. "_comment") buang kuncinya.
function normalizeUnderscoreKeys(item: any): boolean {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  let changed = false;
  for (const key of Object.keys(item)) {
    if (!key.startsWith('_')) continue;
    const stripped = key.replace(/^_+/, '');
    if (
      KNOWN_EVIDENCE_FIELDS.has(stripped) &&
      (item[stripped] === undefined || item[stripped] === null)
    ) {
      item[stripped] = item[key];
    }
    delete item[key];
    changed = true;
  }
  return changed;
}

// Potong teks array evidence menjadi teks objek tingkat-atas. Pemindai sadar
// string; newline mentah dianggap mengakhiri string yang rusak (JSON valid
// tidak pernah memuatnya), sehingga satu tanda kutip nyasar tidak merusak
// pemotongan objek-objek berikutnya.
function splitTopLevelObjects(text: string): { objects: string[]; truncated: boolean } {
  const objects: string[] = [];
  let i = 0;

  const keyIdx = text.indexOf('"evidence"');
  const arrStart = text.indexOf('[', keyIdx === -1 ? 0 : keyIdx);
  if (arrStart === -1) return { objects, truncated: false };
  i = arrStart + 1;

  while (i < text.length) {
    const ch = text[i];
    if (ch === ']') return { objects, truncated: false };
    if (ch !== '{') { i++; continue; }

    const start = i;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        else if (c === '\n') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) return { objects, truncated: true };
    objects.push(text.slice(start, end + 1));
    i = end + 1;
  }
  return { objects, truncated: false };
}

function salvageEvidenceObjects(raw: string): { evidence: any[]; stats: SalvageStats } | null {
  const { objects, truncated } = splitTopLevelObjects(raw);
  if (objects.length === 0) return null;

  const evidence: any[] = [];
  let repaired = 0;
  let skipped = 0;

  for (const objText of objects) {
    let parsed: any;
    let wasRepaired = false;
    try {
      parsed = JSON.parse(objText);
    } catch (_) {
      try {
        parsed = JSON.parse(repairUnquotedKeys(objText));
        wasRepaired = true;
      } catch (_) {
        skipped++;
        continue;
      }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      skipped++;
      continue;
    }
    if (normalizeUnderscoreKeys(parsed)) wasRepaired = true;
    if (wasRepaired) repaired++;
    evidence.push(parsed);
  }

  return {
    evidence,
    stats: { recovered: evidence.length, repaired, skipped, truncated }
  };
}

// ============================================================
// FIX 3 (v5) — AUTO-FILL evidence_id
// ============================================================
// Model besar (Gemini Flash) kadang lupa emit field evidence_id di
// chunk besar. Pipeline saat ini punya fallback "position/missing-ids"
// di related-ids.ts yang menyelamatkan mapping related_evidence_ids,
// tapi item.evidence_id tetap kosong sampai diproses di server.
//
// Helper ini mengisi evidence_id dengan format "E001", "E002", ...
// (3 digit zero-padded) berdasarkan posisi item dalam array — HANYA
// jika model tidak emit evidence_id atau emit string kosong.
//
// Kalau model sudah emit evidence_id (format apapun), TIDAK diubah —
// mencegah konflik dengan referensi model ke ID tersebut.
//
// Return: jumlah item yang di-fill (untuk logging di caller).
function ensureEvidenceIds(evidence: any[]): {
  filled: number;
  metadata: EvidenceIdMetadata[];
} {
  const metadata: EvidenceIdMetadata[] = [];
  let filled = 0;

  for (let i = 0; i < evidence.length; i++) {
    const item = evidence[i];
    const position = i + 1;

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      metadata.push({
        position,
        source: 'invalid',
        originalId: null
      });
      continue;
    }

    const current = item.evidence_id;
    const originalId =
      current === undefined || current === null
        ? null
        : String(current).trim() || null;

    const missing = originalId === null;

    if (missing) {
      item.evidence_id = `E${String(position).padStart(3, '0')}`;
      filled++;
    }

    metadata.push({
      position,
      source: missing ? 'auto-fill' : 'model',
      originalId
    });
  }

  return { filled, metadata };
}

/**
 * Production signature — dipakai oleh server.ts.
 * Perilaku TIDAK BERUBAH dari implementasi production sebelumnya:
 * mengembalikan array evidence (bisa kosong bila semua strategi gagal).
 */
export function parseEvidenceJSON(rawOutput: string): EvidenceItem[] {
  const { evidence, strategy } = parseEvidenceJSONCore(rawOutput);
  // FIX 3: auto-fill evidence_id jika model tidak emit.
  // Hanya log warning jika parse SUCCESS (strategy != null) dan ada
  // evidence yang di-fill — konfirmasi model lupa, bukan parse gagal.
  if (strategy !== null && evidence.length > 0) {
    const { filled } = ensureEvidenceIds(evidence);
    if (filled > 0) {
      console.warn(
        `⚠️ ${filled}/${evidence.length} evidence tanpa evidence_id ` +
        `(di-auto-fill dengan posisi, strategy=${strategy})`
      );
    }
  }
  return evidence;
}

/**
 * Diagnostic signature — dipakai oleh reproducibility harness.
 * Menjalankan CORE YANG SAMA PERSIS dengan parseEvidenceJSON production,
 * tetapi juga melaporkan status SUCCESS/FAILED dan strategi mana yang
 * berhasil, untuk kebutuhan reproducibility artifact.
 *
 * PENTING: production sendiri tidak pernah "gagal" secara eksplisit —
 * ia hanya mengembalikan [] sebagai fallback terakhir. Field `status`
 * di sini murni untuk pelaporan E.3D, bukan perilaku production yang
 * berbeda.
 */
export function parseEvidenceJSONDetailed(rawOutput: string): {
  status: 'SUCCESS' | 'FAILED';
  evidence: any[];
  strategy: ParseStrategy;
  idMetadata: EvidenceIdMetadata[];
  error?: string;
  salvage?: SalvageStats;
} {
  const { evidence, strategy, salvage } = parseEvidenceJSONCore(rawOutput);

    if (strategy === null) {
    return {
      status: 'FAILED',
      evidence: [],
      strategy: null,
      idMetadata: [],
      error: 'Gagal parse JSON dari rawOutput (semua strategi fallback gagal)'
    };
  }

    let idMetadata: EvidenceIdMetadata[] = [];

  if (evidence.length > 0) {
    const { filled, metadata } = ensureEvidenceIds(evidence);
    idMetadata = metadata;
    if (filled > 0) {
      console.warn(
        `⚠️ ${filled}/${evidence.length} evidence tanpa evidence_id ` +
        `(di-auto-fill dengan posisi, strategy=${strategy})`
      );
    }
  }

  return salvage
    ? { status: 'SUCCESS', evidence, strategy, idMetadata, salvage }
    : { status: 'SUCCESS', evidence, strategy, idMetadata };
}

// ============================================================
// NORMALISASI FIELD KOSONG (string "" / "null" -> null)
// ============================================================
// Kasus nyata (video 07DQ9c6-KxA, chunk 2): model menulis
//   "value": "", "unit": "null"      (STRING, bukan JSON null)
// pada 21 dari 35 item. Validator VALUE membaca value "" sebagai non-numerik
// yang tidak cocok dengan unit "null", sehingga 21 evidence yang isinya sah
// masuk quarantine hanya karena format. Sebelumnya juga terlihat unit "unit".
// Semantik string-string ini sama dengan null, jadi dinormalisasi SEBELUM
// validasi. Hanya field yang boleh kosong; claim dan source_excerpt TIDAK
// disentuh.
//
// CHANGELOG (v2):
//   - Tambah NULLABLE_ARRAY_FIELDS untuk `related_evidence_ids`. Field ini
//     bertipe string[] | null, tapi model kadang mengeluarkan string
//     "null"/"none"/"" (bukan JSON null). Sebelumnya tidak dinormalisasi,
//     sehingga lolos ke remapRelatedIds dan mengganggu pemetaan. Sekarang:
//       string nullish -> null
//       array           -> dibiarkan (termasuk [] kosong)
//       string non-nullish -> dibiarkan (remapRelatedIds punya handling sendiri)

const NULLISH_TOKENS = new Set(['', 'null', 'none', 'n/a', 'nil', 'undefined']);

const NULLABLE_EVIDENCE_FIELDS = [
  'subtopic', 'value', 'unit', 'attribute', 'attribute_value',
  'context', 'comparison_target', 'reviewer_assessment'
] as const;

// Field yang bertipe array-of-string | null. Ditangani terpisah dari
// scalar nullable karena aturan normalisasinya berbeda.
const NULLABLE_ARRAY_FIELDS = [
  'related_evidence_ids'
] as const;

/**
 * Mengubah nilai string kosong/placeholder pada field nullable menjadi null.
 * Mengembalikan jumlah field yang diubah (untuk logging). Mengubah objek di
 * tempat.
 */
export function normalizeNullishFields(ev: any): number {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return 0;
  let changed = 0;

  // Scalar nullable: string kosong / "null" / dst -> null.
  for (const field of NULLABLE_EVIDENCE_FIELDS) {
    const v = ev[field];
    if (typeof v !== 'string') continue;
    const t = v.trim().toLowerCase();
    if (NULLISH_TOKENS.has(t) || (field === 'unit' && t === 'unit')) {
      ev[field] = null;
      changed++;
    }
  }

  // Array-of-string nullable: HANYA string nullish yang diubah ke null.
  // Array (termasuk []) dan string non-nullish dibiarkan apa adanya.
  for (const field of NULLABLE_ARRAY_FIELDS) {
    const v = ev[field];
    if (typeof v === 'string') {
      const t = v.trim().toLowerCase();
      if (NULLISH_TOKENS.has(t)) {
        ev[field] = null;
        changed++;
      }
    }
  }

  return changed;
}

// ============================================================
// IDENTITY / METADATA CONTEXT
// ============================================================

export function buildMetadataContext(metadata: ReviewMetadata): string {
  const fields = [
    ['ID', metadata.id],
    ['URL', metadata.url],
    ['Judul Video', metadata.title],
    ['Channel', metadata.channel],
    ['Thumbnail', metadata.thumbnail],
    ['Durasi', metadata.duration],
    ['Views', metadata.views],
    ['Tanggal Publikasi', metadata.uploadDate],
    ['Jumlah Komentar', metadata.commentCount]
  ];

  return fields
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([label, value]) => `${label}: ${value}`)
    //.join('\\n');
    // PERBAIKAN: source sebelumnya `.join('\\n')` -- dua backslash --
    // yang di-parse JS menjadi STRING LITERAL dua karakter "\n" (backslash
    // + huruf n), BUKAN karakter newline. Akibatnya seluruh field metadata
    // (ID, URL, Judul Video, dst) tergabung jadi SATU baris panjang dengan
    // teks "\n" literal di antaranya, bukan baris terpisah, di setiap
    // prompt summary maupun evidence yang mengandung metadata.
    .join('\n');
}

export function getReviewerName(
  metadata: ReviewMetadata,
  fallback = 'Reviewer'
): string {
  if (typeof metadata.channel === 'string' && metadata.channel.trim()) {
    return metadata.channel.trim();
  }

  return fallback;
}

// ============================================================
// EVIDENCE EXTRACTION PROMPT INSTRUCTION BUILDER
// ============================================================
// Satu-satunya tempat yang menyusun instruction lengkap yang
// dikirim ke model untuk tahap evidence extraction. server.ts
// dan harness WAJIB memanggil fungsi ini, bukan menyusun ulang
// string instruksi secara manual.

export function buildEvidenceInstruction(
  metadata: ReviewMetadata,
  reviewerNameFallback: string,
  batchNumber: number,
  totalBatches: number,
  promptOverride?: string
): string {
  const resolvedReviewerName = getReviewerName(metadata, reviewerNameFallback);
  const metadataContext = buildMetadataContext(metadata);
  const promptToUse = promptOverride ?? ANALYSIS_PROMPT_EVIDENCE;

  return (
    `IDENTITAS REVIEW:\n${metadataContext || `Channel/Reviewer: ${resolvedReviewerName}`}\n\n` +
    `SOURCE OF TRUTH: transcript.srt.\n` +
    `Metadata tidak boleh digunakan untuk membuat evidence isi produk.\n\n` +
    promptToUse
      .replace(/\{batch\}/g, batchNumber.toString())
      .replace(/\{total_batches\}/g, totalBatches.toString()) +
    `\n\n` +
    `==================================================\n` +
    `INSTRUKSI CHUNK\n` +
    `==================================================\n` +
    `Anda sedang memproses bagian ${batchNumber} dari ${totalBatches} bagian transcript.\n` +
    `Chunk ini terdiri dari segment SRT utuh.\n` +
    // --- BARU: penjelasan format penanda ---
    `FORMAT INPUT: Setiap segmen SRT diberi penanda [N] di depan, ` +
    `di mana N adalah nomor segmen SRT asli.\n` +
    `Contoh: "[31] HP masih kelihatan. [32] tapi masih kelihatan dan usable."\n` +
    `Penanda [N] hanya untuk menunjukkan batas antar segmen SRT. ` +
    `JANGAN menyertakan penanda [N] di dalam source_excerpt.\n` +
    // ---------------------------------------
    `Ekstrak SELURUH evidence relevan yang benar-benar terdapat pada chunk ini.\n` +
    `Jangan membatasi jumlah evidence secara artifisial.\n` +
    `Jangan mengarang evidence dari chunk atau review lain.\n` +
    `Pertahankan angka, unit, konteks, perbandingan, opini, caveat, dan trade-off.\n` +
    `source_excerpt WAJIB berasal dari teks transcript yang diberikan, ` +
    `dan WAJIB berada dalam MAKSIMAL 3 segmen SRT BERTURUT-TURUT ` +
    `(prioritaskan 1 segmen bila memungkinkan).\n` +
    `Output harus berupa JSON valid dengan struktur {"evidence":[...]}.\n`
  );
}

export const PRODUCTION_SYSTEM_INSTRUCTION_EVIDENCE =
  'Anda adalah ekstraktor evidence produk. Hanya output JSON yang valid. Jangan memberikan komentar di luar JSON.';
