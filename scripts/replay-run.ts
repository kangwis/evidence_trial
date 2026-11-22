// ============================================================
// REPLAY RUN — parser + validator pada output mentah tersimpan
// ============================================================
// Tanpa API. Membaca (ditulis server.ts sejak patch run log):
//   runs/runs.jsonl
//   runs/<run_id>/chunk-N.raw.txt
//   runs/_srt/<srt_sha>.srt
//
// Pakai (dari root proyek):
//   npx tsx scripts/replay-run.ts                        run terakhir
//   npx tsx scripts/replay-run.ts <run_id | prefix>      satu run
//   npx tsx scripts/replay-run.ts --all                  semua run yang punya raw
//   npx tsx scripts/replay-run.ts <run|--all> --json out.json   simpan keputusan per item
//   npx tsx scripts/replay-run.ts <run|--all> --diff out.json   bandingkan dengan simpanan
//   Tambah --full untuk menampilkan SEMUA item (default 40 pertama).
//
//   npx tsx scripts/replay-run.ts --all --filter NOT_FOUND
//   npx tsx scripts/replay-run.ts --all --filter NOT_FOUND --full --sample 20
//   npx tsx scripts/replay-run.ts --all --filter ELLIPSIS
//   --filter <KIND>: MULTI_SRT | ELLIPSIS | NOT_FOUND | AMBIGUOUS | MISSING_MEANINGFUL | OTHER
//
//   npx tsx scripts/replay-run.ts --all --audit ASSESSMENT
//   npx tsx scripts/replay-run.ts --all --audit ATOMICITY --full
//   npx tsx scripts/replay-run.ts --all --audit VALUE
//   --audit <RULE>: analisis terfokus per aturan (agregat type + keyword
//                    + co-occurrence + sampel karantina). Berbeda dari
//                    --filter yang hanya untuk GROUNDING/PROVENANCE.
//
//   Tambah --duplicates untuk menjalankan DuplicateValidator.detect()
//   di atas evidence yang lolos validator. ID evidence di output ini
//   SINTETIS (format "c<chunk>:<pos>") dan hanya stabil DALAM SATU REPLAY;
//   jangan dipakai untuk membandingkan antar-run. Untuk investigasi
//   "kenapa pair X tidak terdeteksi duplikat", cari berdasarkan excerpt
//   atau source_coordinates, bukan evidence_id.
//
// ALUR SEBELUM/SESUDAH (perbandingan apple-to-apple untuk perubahan ATURAN):
//   1. Dengan kode LAMA:   --all --json before.json
//   2. Terapkan perubahan aturan.
//   3. Dengan kode BARU:   --all --diff before.json
//   Input kedua replay adalah file raw yang sama; laporan --diff memverifikasi
//   itu lewat raw_sha dan menolak menyebutnya apple-to-apple jika berbeda.
//   Perubahan PROMPT/model tidak bisa diuji dengan replay (butuh run baru).
//
// Cakupan : parse JSON -> filter struktural -> auto-reconcile tipe ->
//           EvidenceValidator.validate (grounding, provenance, assessment,
//           value, atomicity).
//           + (opsional, --duplicates) DuplicateValidator.detect.
// Di luar : duplicate gate resolution (resolveDuplicateActions),
//           pemetaan relasi (remapRelatedIds), auto-fill relation,
//           pemanggilan LLM.
// Chunk yang gagal diparse otomatis didiagnosis (terpotong / sintaks rusak / teks tambahan).
//
// Tiga hasil per item:
//   diterima        : lolos semua aturan
//   diterima+flag   : lolos, tetapi ada aturan non-PASS yang tidak memblokir
//                     (mis. ASSESSMENT SUSPECT LOW)
//   karantina       : FAIL atau SUSPECT HIGH
//
// Mirror server.ts: normalizeNullishFields -> reconcile -> validate.
// CATATAN DRIFT: isValidEvidence dan reconcileTypeWithAssessment di bawah
// adalah SALINAN dari server.ts. Kolom "parity" membandingkan hasil replay
// dengan angka asli di runs.jsonl. BEDA itu wajar bila validator sengaja
// diubah sejak run; jika kode tidak diubah tetapi BEDA, salinan ini sudah
// tidak sinkron dengan server.ts.
// ============================================================

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  parseSRT,
  buildEvidenceChunks,
  buildChunkText,
  parseEvidenceJSONDetailed,
  normalizeNullishFields
} from '../src/evidence/production-pipeline';
import { EvidenceValidator } from '../src/evidence/validators/evidence-validator';
// Namespace import: tetap jalan pada assessment.ts lama yang belum punya
// ASSESSMENT_RULES_VERSION (dilaporkan sebagai "legacy").
import * as assessmentModule from '../src/evidence/validators/assessment';
// DuplicateValidator: untuk mode --duplicates.
import { DuplicateValidator } from '../src/evidence/validators/duplicate';
import type { SRTSegment } from '../src/evidence/srt';
import { collectAmbiguous, printAmbiguousReport } from './ambiguous-report';
import type { DuplicateResult } from '../src/evidence/validators/duplicate';
import type { EvidenceContext, EvidenceItem } from '../src/evidence/types';

const RULES_VERSION: string =
  (assessmentModule as unknown as { ASSESSMENT_RULES_VERSION?: string }).ASSESSMENT_RULES_VERSION ?? 'legacy';

// ------------------------------------------------------------
// Tipe
// ------------------------------------------------------------
interface ChunkRecord {
  chunk: number;
  status: string;
  raw_chars: number | null;
  // Dicatat server.ts sejak run log. Opsional: run lama bisa tidak punya.
  segments?: [number, number];
  chars?: number;
  parsed: number;
  accepted: number;
  quarantine: number;
}

interface RunRecord {
  run_id: string;
  review_id?: string | null;
  srt_sha: string;
  chunk_chars?: number;
  chunk_overlap?: number;
  code_hash?: string;
  git_commit?: string;
  parsed_evidence?: number;
  validator_accepted?: number;
  quarantine?: number;
  chunks: ChunkRecord[];
}

type Outcome = 'diterima' | 'diterima+flag' | 'karantina';

// Hasil verifikasi rekonstruksi chunk terhadap record run asli.
type ContextStatus = 'OK' | 'LEGACY_FORMAT' | 'BOUNDARY_DIFF' | 'CHARS_DIFF' | 'UNKNOWN';

// BARU: klasifikasi jenis kegagalan GROUNDING/PROVENANCE.
// Membedakan: melintasi SRT vs elipsis vs tidak ditemukan vs ambigu.
type FailKind = 'MULTI_SRT' | 'ELLIPSIS' | 'NOT_FOUND' | 'AMBIGUOUS' | 'MISSING_MEANINGFUL' | 'OTHER';

// BARU: detail per-blocking (reason + severity), untuk diagnosis breakdown.
interface BlockingDetail {
  rule: string;
  reason: string;
  severity: string;
}

interface ItemDecision {
  subtopic?: string | null;
  key: string;            // "<chunk 1-based>:<posisi 1-based pada hasil parse>"
  chunk: number;
  pos: number;
  accepted: boolean;
  type: string;
  claim: string;
  excerpt: string;
  blocking: string[];     // aturan yang menyebabkan quarantine
  blockingDetails: BlockingDetail[];  // BARU: reason detail per rule
  flags: string[];        // aturan non-PASS yang TIDAK memblokir (item diterima)
  reason: string;
  // BARU: dipakai mode --filter untuk diagnosa excerpt vs SRT
  chunkText?: string;
  sourceCoordinates?: {
    chunk_index?: number;
    segment_start_index?: number;
    segment_end_index?: number;
  };
}

interface ChunkReplay {
  chunk: number;
  parsed: number;
  structurallyInvalid: number;
  accepted: number;
  flagged: number;
  quarantine: number;
  parseStatus: string;
  strategy: string;
  note?: string;
  diagnosis?: string[];
  // Verifikasi rekonstruksi chunk terhadap run asli.
  ctx?: ContextStatus;
  ctxDetail?: string;
}

interface ReplayResult {
  run: RunRecord;
  chunks: ChunkReplay[];
  chunkSegments?: Map<number, SRTSegment[]>;
  items: ItemDecision[];
  notes: string[];
  rawSha: string;         // hash seluruh file raw yang dipakai (bukti input identik)
  // true bila isi file SRT cocok dengan run.srt_sha; false bila tidak;
  // undefined bila SRT tidak ditemukan.
  srtVerified?: boolean;
  // Hash ISI file SRT yang dibaca replay ini (bukan srt_sha tercatat).
  srtContentSha?: string;
  // Hanya diisi jika withDuplicates=true:
  acceptedForDedup?: EvidenceItem[];  // evidence dengan ID sintetis "c<chunk>:<pos>"
  duplicates?: DuplicateResult;
}

interface SavedRun {
  run_id?: string;
  code_hash?: string;
  rules_version?: string;
  raw_sha?: string;
  // Fingerprint konteks rekonstruksi. Opsional: simpanan lama tidak punya.
  // chunk_* bernilai null bila run asli tidak mencatatnya.
  srt_sha?: string;
  // Hash ISI file SRT saat snapshot dibuat. Opsional: simpanan sebelum
  // Patch 1c tidak punya.
  srt_content_sha?: string | null;
  chunk_chars?: number | null;
  chunk_overlap?: number | null;
  items: ItemDecision[];
}

// Sinkron dengan maxSpan di provenance.ts / grounding.ts (Opsi A). Hanya
// untuk teks diagnostik; bukan sumber kebenaran.
const PROVENANCE_MAX_SPAN = 5;

// Aturan --audit yang TIDAK dievaluasi replay: replayRun hanya menjalankan
// EvidenceValidator.validate (5 aturan per-evidence). TimestampValidator dan
// RelationValidator berjalan pasca-duplicate-gate di server.ts. Hasil "0
// karantina" untuk keduanya akan salah dibaca sebagai "lolos".
const AUDIT_NOT_EVALUATED = ['TIMESTAMP', 'RELATION'];

const REPLAY_SCOPE_NOTE =
  'LINGKUP REPLAY: parse + filter struktural + reconcile + 5 validator per-evidence. ' +
  'TIDAK mencakup duplicate resolution, remap related_evidence_ids, TIMESTAMP, RELATION. ' +
  '"accepted" di sini BUKAN jumlah evidence final produksi.';

// Sama dengan shortHash di server.ts (sha256 hex, 8 karakter pertama).
function shortHash(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 8);
}

function outcomeOf(i: { accepted: boolean; flags?: string[] }): Outcome {
  if (!i.accepted) return 'karantina';
  return (i.flags?.length ?? 0) > 0 ? 'diterima+flag' : 'diterima';
}

// ------------------------------------------------------------
// Salinan dari server.ts (lihat CATATAN DRIFT)
// ------------------------------------------------------------
function isValidEvidence(ev: any): boolean {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return false;
  return typeof ev.claim === 'string' && ev.claim.trim().length > 0;
}

function reconcileTypeWithAssessment(ev: EvidenceItem): EvidenceItem {
  const hasAssessment =
    ev.reviewer_assessment !== null &&
    ev.reviewer_assessment !== undefined &&
    String(ev.reviewer_assessment).trim() !== '';
  const normalizedType = (ev.type || '').toUpperCase();
  if (hasAssessment && normalizedType !== 'OPINION') {
    return { ...ev, type: 'OPINION' };
  }
  return ev;
}

// Hash isi file kode kunci (salinan daftar dari server.ts; hanya indikatif).
function computeCodeHash(): string {
  const files: string[] = [
    'server.ts',
    'prompts.ts',
    'src/llm/llm-provider.ts',
    'src/evidence/production-pipeline.ts',
    'src/evidence/related-ids.ts',
    'src/evidence/search.ts',
    'src/evidence/srt.ts',
    'src/evidence/text-matching.ts'
  ];
  try {
    const vdir = 'src/evidence/validators';
    for (const f of fs.readdirSync(vdir).sort()) {
      if (f.endsWith('.ts')) files.push(`${vdir}/${f}`);
    }
  } catch { /* abaikan */ }
  const h = crypto.createHash('sha256');
  for (const f of files) {
    try {
      h.update(f);
      h.update(fs.readFileSync(f));
    } catch { /* file tidak ada */ }
  }
  return h.digest('hex').slice(0, 8);
}

// ------------------------------------------------------------
// I/O
// ------------------------------------------------------------
const RUN_LOG_DIR = path.resolve(process.env.EVIDENCE_RUN_LOG_DIR ?? './runs');

function readRuns(): RunRecord[] {
  const file = path.join(RUN_LOG_DIR, 'runs.jsonl');
  if (!fs.existsSync(file)) return [];
  const out: RunRecord[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && r.run_id && r.srt_sha && Array.isArray(r.chunks)) out.push(r);
    } catch { /* baris rusak dilewati */ }
  }
  return out;
}

function hasRaw(r: RunRecord): boolean {
  return fs.existsSync(path.join(RUN_LOG_DIR, r.run_id));
}

// ------------------------------------------------------------
// Diagnosis kegagalan parse
// ------------------------------------------------------------
// Menjawab: JSON terpotong? ada kesalahan sintaks di tengah (mis. tanda kutip
// tidak di-escape)? atau ada teks tambahan setelah JSON?
function diagnoseParseFailure(rawOutput: string): string[] {
  const out: string[] = [];
  const text = rawOutput.replace(/^\uFEFF/, '').trim();
  out.push(`panjang=${text.length} | awal: ${JSON.stringify(text.slice(0, 70))}`);
  out.push(`akhir: ${JSON.stringify(text.slice(-110))}`);

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const hasFence = text.includes('```');
  out.push(
    `pagar kode: ${fenced ? 'lengkap' : hasFence ? 'dibuka tetapi TIDAK ditutup (indikasi terpotong)' : 'tidak ada'}`
  );

  const body = (fenced?.[1] ?? text.replace(/^```(?:json)?\s*/i, '')).trim();

  // Pemindaian: kedalaman kurung di luar string, string tidak tertutup,
  // dan teks setelah objek/array pertama selesai.
  let depth = 0;
  let inStr = false;
  let esc = false;
  let firstEnd = -1;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0 && firstEnd < 0) firstEnd = i;
    }
  }
  if (inStr) out.push('string TIDAK tertutup di akhir output (kuat: terpotong di tengah teks)');
  if (depth > 0) out.push(`kurung belum tertutup (kedalaman akhir=${depth}) -> output terpotong`);
  if (firstEnd >= 0 && body.slice(firstEnd + 1).trim().length > 0) {
    out.push(`ada teks SETELAH JSON selesai: ${JSON.stringify(body.slice(firstEnd + 1).trim().slice(0, 100))}`);
  }

  try {
    JSON.parse(body);
    out.push('JSON.parse(isi) BERHASIL tetapi bentuknya bukan {"evidence":[...]} atau [...]');
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    out.push(`JSON.parse: ${msg}`);
    const m = /position (\d+)/.exec(msg);
    if (m) {
      const pos = Number(m[1]);
      out.push(
        `konteks @${pos}: ${JSON.stringify(body.slice(Math.max(0, pos - 90), pos))} <<< DI SINI >>> ` +
        `${JSON.stringify(body.slice(pos, pos + 50))}`
      );
    }
  }
  return out;
}

// ------------------------------------------------------------
// Replay satu run
// ------------------------------------------------------------
// Bandingkan chunk hasil rekonstruksi dengan record chunk run asli.
// BOUNDARY_DIFF diprioritaskan di atas CHARS_DIFF.
function verifyChunkContext(
  orig: ChunkRecord | undefined,
  chunk: SRTSegment[]
): { status: ContextStatus; detail: string } {
  if (!orig) {
    return { status: 'UNKNOWN', detail: 'record chunk run asli tidak ada' };
  }
  if (!orig.segments || orig.chars === undefined) {
    return { status: 'UNKNOWN', detail: 'segments/chars tidak tercatat di run asli' };
  }

  const first = chunk[0]?.index;
  const last = chunk[chunk.length - 1]?.index;
  const chars = buildChunkText(chunk).length;

  if (orig.segments[0] !== first || orig.segments[1] !== last) {
    return {
      status: 'BOUNDARY_DIFF',
      detail: `segmen asli ${orig.segments[0]}..${orig.segments[1]} vs rekonstruksi ${first}..${last}`
    };
  }
  if (orig.chars !== chars) {
    return {
      status: 'CHARS_DIFF',
      detail: `chars asli ${orig.chars} vs rekonstruksi ${chars} (selisih ${chars - orig.chars})`
    };
  }
  return { status: 'OK', detail: '' };
}

function replayRun(run: RunRecord, withDuplicates: boolean = false): ReplayResult {
  const notes: string[] = [];
  const chunks: ChunkReplay[] = [];
  const items: ItemDecision[] = [];
  const chunkSegmentsMap = new Map<number, SRTSegment[]>();
  const rawHash = crypto.createHash('sha256');

  // Evidence yang lolos validator, dipakai untuk duplicate gate.
  // ID di sini SINTETIS: "c<chunk1based>:<pos1based pada parsedItems>".
  // Stabil DALAM satu replay saja (karena chunk+pos deterministik untuk
  // input raw yang sama), tidak stabil antar-run.
  const acceptedForDedup: EvidenceItem[] = [];

  const srtPath = path.join(RUN_LOG_DIR, '_srt', `${run.srt_sha}.srt`);
  if (!fs.existsSync(srtPath)) {
    notes.push(`SRT tidak ditemukan: ${srtPath}`);
    return { run, chunks, items, notes, rawSha: '-' };
  }

  const srtText = fs.readFileSync(srtPath, 'utf8');
  const srtVerified = shortHash(srtText) === run.srt_sha;
  if (!srtVerified) {
    notes.push(
      `Isi file SRT (${shortHash(srtText)}) TIDAK cocok dengan srt_sha tercatat ` +
      `(${run.srt_sha}); file diubah manual? Konteks validasi tidak terjamin.`
    );
  }
  const segments = parseSRT(srtText);
  const evChunks = buildEvidenceChunks(
    segments,
    run.chunk_chars ?? 18000,
    run.chunk_overlap ?? 3
  );
  if (evChunks.length !== run.chunks.length) {
    notes.push(
      `Jumlah chunk hasil rekonstruksi (${evChunks.length}) berbeda dari run asli ` +
      `(${run.chunks.length}); cek EVIDENCE_CHUNK_CHARS / EVIDENCE_CHUNK_OVERLAP.`
    );
  }

  let acceptLogicMismatch = 0;

  evChunks.forEach((chunk, chunkIndex) => {
    const n = chunkIndex + 1;
    chunkSegmentsMap.set(n, chunk);
    const ctxCheck = verifyChunkContext(run.chunks.find(c => c.chunk === n), chunk);
    const rawPath = path.join(RUN_LOG_DIR, run.run_id, `chunk-${n}.raw.txt`);
    if (!fs.existsSync(rawPath)) {
      chunks.push({
        chunk: n, parsed: 0, structurallyInvalid: 0, accepted: 0, flagged: 0, quarantine: 0,
        parseStatus: '-', strategy: '-', note: 'raw tidak ada (chunk gagal di run asli?)',
        ctx: ctxCheck.status, ctxDetail: ctxCheck.detail
      });
      return;
    }

    const rawText = fs.readFileSync(rawPath, 'utf8');
    rawHash.update(`chunk-${n}:`);
    rawHash.update(rawText);
    const parsedResult = parseEvidenceJSONDetailed(rawText);
    const parsedItems = parsedResult.evidence as EvidenceItem[];
    const positionOf = new Map<unknown, number>();
    parsedItems.forEach((e, i) => positionOf.set(e, i + 1));

    const valid = parsedItems.filter(isValidEvidence);
    const context: EvidenceContext = {
      chunkIndex,
      chunkText: buildChunkText(chunk),
      chunkSegments: chunk
    };

    let accepted = 0;
    let flagged = 0;
    let quarantine = 0;
    for (const ev of valid) {
      normalizeNullishFields(ev); // mirror server.ts: string kosong/"null" -> null
      const reconciled = reconcileTypeWithAssessment(ev);
      const report = EvidenceValidator.validate(reconciled, context);
      const isBlocking = (r: { status: string; severity?: string }) =>
        r.status === 'FAIL' || (r.status === 'SUSPECT' && r.severity === 'HIGH');
      const blockingResults = report.results.filter(isBlocking);
      const blocking = blockingResults.map(r => r.rule);
      // BARU: kumpulkan reason+severity untuk breakdown diagnosa.
      const blockingDetails: BlockingDetail[] = blockingResults.map(r => ({
        rule: r.rule,
        reason: r.reason ?? '',
        severity: r.severity ?? ''
      }));
      const flags = report.accepted
        ? Array.from(new Set(
            report.results
              .filter(r => r.status !== 'PASS' && !isBlocking(r))
              .map(r => (r as { code?: string }).code ?? r.rule)
          ))
        : [];
      // evidence-validator memblokir sesuatu yang menurut aturan blocking di sini lolos?
      if (!report.accepted && blocking.length === 0) acceptLogicMismatch++;
      const pos = positionOf.get(ev) ?? 0;
      if (report.accepted) { accepted++; if (flags.length) flagged++; } else quarantine++;
      items.push({
        key: `${n}:${pos}`,
        chunk: n,
        pos,
        accepted: report.accepted,
        type: String(reconciled.type ?? ''),
        subtopic: reconciled.subtopic ?? null,
        claim: String(ev.claim ?? ''),
        excerpt: String(ev.source_excerpt ?? ''),
        blocking: report.accepted ? [] : Array.from(new Set(blocking)),
        blockingDetails,  // BARU
        flags,  
        reason: report.quarantineReason ?? '',
        // BARU:
        chunkText: context.chunkText,
        sourceCoordinates: (reconciled as any).source_coordinates
      });

      // Kumpulkan evidence yang lolos untuk duplicate gate.
      if (withDuplicates && report.accepted) {
        acceptedForDedup.push({
          ...reconciled,
          evidence_id: `c${n}:${pos}`
        });
      }
    }

    chunks.push({
      chunk: n,
      parsed: parsedItems.length,
      structurallyInvalid: parsedItems.length - valid.length,
      accepted,
      flagged,
      quarantine,
      parseStatus: parsedResult.status,
      strategy: String(parsedResult.strategy),
      note: (parsedResult as any).salvage
        ? `diselamatkan ${(parsedResult as any).salvage.recovered} item (diperbaiki ${(parsedResult as any).salvage.repaired}, dilewati ${(parsedResult as any).salvage.skipped}${(parsedResult as any).salvage.truncated ? ', terpotong' : ''})`
        : undefined,
      diagnosis: parsedResult.status === 'FAILED' ? diagnoseParseFailure(rawText) : undefined,
      ctx: ctxCheck.status,
      ctxDetail: ctxCheck.detail
    });
  });

  if (acceptLogicMismatch > 0) {
    notes.push(
      `${acceptLogicMismatch} item dikarantina oleh EvidenceValidator padahal tidak ada FAIL / SUSPECT HIGH. ` +
      `Aturan "blocking" di skrip ini tidak sama dengan evidence-validator.ts; cek logika report.accepted ` +
      `(mungkin memakai result.pass, sehingga SUSPECT LOW ikut memblokir).`
    );
  }

  let duplicates: DuplicateResult | undefined;
  if (withDuplicates && acceptedForDedup.length > 0) {
    duplicates = DuplicateValidator.detect(acceptedForDedup);
  }

  return {
    run, chunks, items, notes,
    chunkSegments: chunkSegmentsMap,
    rawSha: rawHash.digest('hex').slice(0, 12),
    srtVerified,
    srtContentSha: shortHash(srtText),
    acceptedForDedup: withDuplicates ? acceptedForDedup : undefined,
    duplicates
  };
}

// ------------------------------------------------------------
// Pelaporan
// ------------------------------------------------------------
function trunc(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function pad(s: string | number, n: number): string {
  return String(s).padEnd(n);
}

function byRule(items: Array<{ accepted: boolean; blocking: string[] }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    if (it.accepted) continue;
    for (const r of it.blocking) out[r] = (out[r] ?? 0) + 1;
  }
  return out;
}

function flagsByRule(items: Array<{ accepted: boolean; flags?: string[] }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    if (!it.accepted) continue;
    for (const r of it.flags ?? []) out[r] = (out[r] ?? 0) + 1;
  }
  return out;
}

function fmtRules(o: Record<string, number>): string {
  return Object.keys(o).sort().map(k => `${k}=${o[k]}`).join('  ') || '-';
}

// BARU: klasifikasi teks `reason` dari validator GROUNDING/PROVENANCE
// ke salah satu jenis kegagalan. Dipakai untuk breakdown diagnosa.
function classifyFailReason(reason: string): FailKind {
  if (/melintasi lebih dari satu segmen/i.test(reason)) return 'MULTI_SRT';
  if (/mengandung elipsis/i.test(reason)) return 'ELLIPSIS';
  if (/ambiguous/i.test(reason)) return 'AMBIGUOUS';
  if (/tidak ditemukan di originating chunk/i.test(reason)) return 'NOT_FOUND';
  if (/memuat kata bermakna yang tidak ada/i.test(reason)) return 'MISSING_MEANINGFUL';
  if (/melintasi.*segmen SRT.*maksimum/i.test(reason)) return 'MULTI_SRT';
  return 'OTHER';
}

// ------------------------------------------------------------
// BARU: diagnosa excerpt vs chunk (khusus mode --filter)
// ------------------------------------------------------------
const NARRATIVE_PREFIXES = [
  'reviewer menilai', 'reviewer menyatakan', 'reviewer menyebut',
  'reviewer menganggap', 'reviewer merasa', 'reviewer mencatat',
  'reviewer melaporkan', 'reviewer mengamati', 'reviewer menguji',
  'model menilai', 'pengulas menilai', 'penulis menilai',
  'narasumber menilai', 'reviewer juga menilai'
];

function detectNarrativePrefix(excerpt: string): string | null {
  const lower = excerpt.toLowerCase().trim();
  for (const p of NARRATIVE_PREFIXES) if (lower.startsWith(p)) return p;
  return null;
}

function tokenizeWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9à-ÿ]+/gi, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);
}

function computeTokenCoverage(excerpt: string, chunkText: string): {
  coverage: number; matched: string[]; missing: string[];
} {
  const eTokens = tokenizeWords(excerpt);
  const cNorm = ' ' + chunkText.toLowerCase().replace(/[^a-z0-9à-ÿ]+/gi, ' ') + ' ';
  const seen = new Set<string>();
  const matched: string[] = [];
  const missing: string[] = [];
  for (const t of eTokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    if (cNorm.includes(` ${t} `) || cNorm.includes(` ${t}`) || cNorm.includes(`${t} `)) matched.push(t);
    else missing.push(t);
  }
  const total = matched.length + missing.length;
  return { coverage: total > 0 ? matched.length / total : 1, matched, missing };
}

// Cari run terpanjang excerpt yang muncul utuh di chunkText (biner search).
function longestCommonRun(excerpt: string, chunkText: string, minLen = 6): string {
  const e = excerpt.toLowerCase().replace(/\s+/g, ' ').trim();
  const c = chunkText.toLowerCase().replace(/\s+/g, ' ').trim();
  let lo = minLen, hi = Math.min(e.length, c.length), best = '';
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    let found = '';
    for (let i = 0; i + mid <= e.length; i++) {
      const sub = e.slice(i, i + mid);
      if (c.includes(sub)) { found = sub; break; }
    }
    if (found) { best = found; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

// Ambil potongan chunk di sekitar `needle` (atau 400 char awal kalau tidak ketemu).
function chunkWindowAround(chunkText: string, needle: string, radius = 220): string {
  const c = chunkText.toLowerCase();
  const probe = needle.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 40);
  const idx = probe.length >= 6 ? c.indexOf(probe) : -1;
  if (idx < 0) return chunkText.slice(0, radius * 2);
  const from = Math.max(0, idx - radius);
  const to = Math.min(chunkText.length, idx + radius);
  return (from > 0 ? '…' : '') + chunkText.slice(from, to) + (to < chunkText.length ? '…' : '');
}

// ------------------------------------------------------------
// BARU: printer sampling --filter
// ------------------------------------------------------------
function printFailureSamples(
  results: ReplayResult[],
  kind: FailKind,
  full: boolean,
  maxPerRun: number
): void {
  console.log('='.repeat(78));
  let total = 0;
  for (const r of results) {
    for (const it of r.items) {
      if (!it.blockingDetails) continue;
      for (const d of it.blockingDetails) {
        if (classifyFailReason(d.reason) === kind &&
            (d.rule === 'GROUNDING' || d.rule === 'PROVENANCE')) {
          total++;
        }
      }
    }
  }
  console.log(`SAMPLING KEGAGALAN: ${kind}  (agregat ${total} entri dari ${results.length} run)`);
  console.log('='.repeat(78));

  const exAgg: string[] = [];
  for (const r of results) {
    const matched: ItemDecision[] = r.items.filter(it => {
      if (it.accepted || !it.blockingDetails) return false;
      return it.blockingDetails.some(d =>
        (d.rule === 'GROUNDING' || d.rule === 'PROVENANCE') &&
        classifyFailReason(d.reason) === kind
      );
    });
    if (matched.length === 0) continue;
    const shown = full ? matched : matched.slice(0, maxPerRun);
    console.log(`\n--- run ${r.run.run_id}  review=${r.run.review_id ?? '-'}  (${matched.length} entri) ---`);

    for (const it of shown) {
      const triggering = it.blockingDetails!.find(d =>
        (d.rule === 'GROUNDING' || d.rule === 'PROVENANCE') &&
        classifyFailReason(d.reason) === kind
      )!;
      const tag = `[c${it.chunk}#${it.pos}]`;
      console.log(`\n${tag} run=${r.run.run_id.slice(11, 19)}  type=${it.type}  rule=${triggering.rule}  sev=${triggering.severity}`);
      console.log(`  CLAIM   : ${trunc(it.claim, 140)}`);
      console.log(`  EXCERPT : ${trunc(it.excerpt, 160)}`);
      console.log(`  REASON  : ${trunc(triggering.reason, 200)}`);
      if (it.sourceCoordinates) {
        const sc = it.sourceCoordinates;
        console.log(`  COORD   : chunk=${sc.chunk_index ?? '-'}  seg=${sc.segment_start_index ?? '-'}..${sc.segment_end_index ?? '-'}`);
      }

      if (kind === 'NOT_FOUND' && it.chunkText) {
        const cov = computeTokenCoverage(it.excerpt, it.chunkText);
        console.log(`  coverage: ${(cov.coverage * 100).toFixed(0)}%  (${cov.matched.length}/${cov.matched.length + cov.missing.length} token ada)`);
        if (cov.missing.length) {
          console.log(`  missing : ${cov.missing.slice(0, 12).join(', ')}${cov.missing.length > 12 ? ' …' : ''}`);
        }
        const np = detectNarrativePrefix(it.excerpt);
        if (np) console.log(`  !! narrative prefix terdeteksi: "${np}" — model menambah framing`);
        const run = longestCommonRun(it.excerpt, it.chunkText, 6);
        if (run) console.log(`  common  : "...${run}..."`);
        else console.log(`  common  : (tidak ada run ≥6 karakter — excerpt bukan substring chunk)`);
        console.log(`  CHUNK(window):`);
        const win = chunkWindowAround(it.chunkText, run || it.excerpt);
        for (const line of win.split(/\n/)) console.log(`    ${trunc(line, 160)}`);
        exAgg.push(np ? 'narrative' : cov.coverage > 0.7 ? 'high-cov' : cov.coverage > 0.3 ? 'med-cov' : 'low-cov');
      }

      if (kind === 'ELLIPSIS') {
        const m = it.excerpt.match(/\.{3,}|…/);
        if (m) {
          const i = m.index ?? 0;
          console.log(`  ellipsis @${i}: ...${it.excerpt.slice(Math.max(0, i - 40), i)}[${m[0]}]${it.excerpt.slice(i + m[0].length, i + m[0].length + 40)}...`);
        }
      }

      if (kind === 'MULTI_SRT' && it.sourceCoordinates && it.chunkText) {
        const sc = it.sourceCoordinates;
        const span = (sc.segment_end_index ?? 0) - (sc.segment_start_index ?? 0) + 1;
        console.log(`  span    : ${span} segmen SRT (batas maxSpan=${PROVENANCE_MAX_SPAN})`);
      }
    }
    if (!full && matched.length > shown.length) {
      console.log(`  ... ${matched.length - shown.length} entri lagi di run ini (pakai --full untuk semua)`);
    }
  }

  // Ringkasan tipe kegagalan (khusus NOT_FOUND)
  if (kind === 'NOT_FOUND' && exAgg.length > 0) {
    const agg: Record<string, number> = {};
    for (const k of exAgg) agg[k] = (agg[k] ?? 0) + 1;
    console.log('\n' + '='.repeat(78));
    console.log('RINGKASAN POLA NOT_FOUND (dari sampel yang ditampilkan):');
    for (const [k, v] of Object.entries(agg).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${pad(k, 14)}${v}`);
    }
    console.log('  narrative = model menambah "Reviewer menilai…" — fix di prompt');
    console.log('  high-cov  = >70% token ada tapi excerpt tidak utuh — cek elipsis/urutan');
    console.log('  med-cov   = paraphrase — model tidak literal');
    console.log('  low-cov   = halusinasi atau excerpt jauh dari chunk');
  }
}

// ------------------------------------------------------------
// AUDIT GENERIK PER RULE — --audit <RULE>
// ------------------------------------------------------------
// Berbeda dari --filter (GROUNDING/PROVENANCE spesifik), audit
// generik bekerja untuk rule apa pun (ASSESSMENT, ATOMICITY, VALUE,
// RELATION, TIMESTAMP, dst).
//
// Agregat:
//   - Per type evidence (OBSERVATION/FACT/MEASUREMENT/...)
//   - Per keyword dari reason (di-parse dari [kata: "..."])
//   - Co-occurrence dengan rule lain (mis. ASSESSMENT+ATOMICITY)
//
// Sampel:
//   - Per run, per item, dengan claim + excerpt + reason + keywords
// ------------------------------------------------------------

function extractQuotedKeywords(reason: string): string[] {
  // Format: [kata: "sangat", "bagus"] atau [kata: 'sangat']
  const m = reason.match(/\[kata:\s*([^\]]+)\]/i);
  if (!m) return [];
  return m[1]
    .split(',')
    .map(s => s.trim().replace(/^["'\u2018\u2019\u201C\u201D`]|["'\u2018\u2019\u201C\u201D`]$/g, '').trim())
    .filter(Boolean);
}

interface AuditStats {
  total: number;
  byType: Record<string, number>;
  byKeyword: Record<string, number>;
  byCoOccurrence: Record<string, number>;
}

function collectAudit(results: ReplayResult[], rule: string): AuditStats {
  const stats: AuditStats = {
    total: 0,
    byType: {},
    byKeyword: {},
    byCoOccurrence: {}
  };

  for (const r of results) {
    for (const it of r.items) {
      if (it.accepted) continue; // hanya karantina
      const details = it.blockingDetails ?? [];
      const matched = details.filter(d => d.rule === rule);
      if (matched.length === 0) continue;

      stats.total++;

      const type = it.type || 'UNKNOWN';
      stats.byType[type] = (stats.byType[type] ?? 0) + 1;

      for (const m of matched) {
        for (const kw of extractQuotedKeywords(m.reason)) {
          stats.byKeyword[kw] = (stats.byKeyword[kw] ?? 0) + 1;
        }
      }

      for (const d of details) {
        if (d.rule === rule) continue;
        stats.byCoOccurrence[d.rule] = (stats.byCoOccurrence[d.rule] ?? 0) + 1;
      }
    }
  }

  return stats;
}

function printAuditSamples(
  results: ReplayResult[],
  rule: string,
  full: boolean,
  maxPerRun: number
): void {
  const stats = collectAudit(results, rule);

  console.log('='.repeat(78));
  console.log(`AUDIT: ${rule}  (agregat ${stats.total} entri karantina dari ${results.length} run)`);
  console.log('='.repeat(78));

  if (stats.total === 0) {
    console.log('\n  (tidak ada item yang dikarantina oleh rule ini)');
    return;
  }

  console.log('\n  Per type:');
  for (const [k, v] of Object.entries(stats.byType).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${pad(k, 22)}${v}`);
  }

  if (Object.keys(stats.byKeyword).length > 0) {
    console.log('\n  Per keyword (dari reason [kata: ...]):');
    const sorted = Object.entries(stats.byKeyword).sort((a, b) => b[1] - a[1]);
    for (const [k, v] of sorted.slice(0, 40)) {
      console.log(`    ${pad(k, 22)}${v}`);
    }
    if (sorted.length > 40) console.log(`    ... ${sorted.length - 40} keyword lagi`);
  }

  if (Object.keys(stats.byCoOccurrence).length > 0) {
    console.log('\n  Co-occurrence dengan rule lain:');
    for (const [k, v] of Object.entries(stats.byCoOccurrence).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${pad(k, 22)}${v}`);
    }
  }

  console.log('\n' + '='.repeat(78));
  console.log('  SAMPEL PER RUN');
  console.log('='.repeat(78));

  for (const r of results) {
    const matched = r.items.filter(it => {
      if (it.accepted) return false;
      return (it.blockingDetails ?? []).some(d => d.rule === rule);
    });
    if (matched.length === 0) continue;

    const shown = full ? matched : matched.slice(0, maxPerRun);
    console.log(`\n--- run ${r.run.run_id}  review=${r.run.review_id ?? '-'}  (${matched.length} entri) ---`);

    for (const it of shown) {
      const detail = (it.blockingDetails ?? []).find(d => d.rule === rule)!;
      const otherRules = (it.blockingDetails ?? [])
        .filter(d => d.rule !== rule)
        .map(d => d.rule)
        .join('+');
      const kw = extractQuotedKeywords(detail.reason);
      console.log(
        `\n[c${it.chunk}#${it.pos}] type=${it.type}  sev=${detail.severity}` +
        `${otherRules ? `  co=${otherRules}` : ''}`
      );
      console.log(`  CLAIM   : ${trunc(it.claim, 140)}`);
      console.log(`  EXCERPT : ${trunc(it.excerpt, 140)}`);
      console.log(`  REASON  : ${trunc(detail.reason, 220)}`);
      if (kw.length > 0) console.log(`  KEYWORDS: ${kw.join(', ')}`);
    }

    if (!full && matched.length > shown.length) {
      console.log(`  ... ${matched.length - shown.length} entri lagi di run ini (pakai --full untuk semua)`);
    }
  }
}

// BARU: hitung breakdown per rule GROUNDING/PROVENANCE.
// Hanya menghitung item yang di-karantina; item accepted diabaikan.
// Aman terhadap simpanan JSON lama (blockingDetails mungkin undefined).
function breakdownByRuleAndKind(
  items: ItemDecision[]
): Map<string, Record<FailKind, number>> {
  const out = new Map<string, Record<FailKind, number>>();
  for (const it of items) {
    if (it.accepted) continue;
    if (!it.blockingDetails || it.blockingDetails.length === 0) continue;
    for (const d of it.blockingDetails) {
      if (d.rule !== 'GROUNDING' && d.rule !== 'PROVENANCE') continue;
            let bucket = out.get(d.rule);
      if (!bucket) {
        bucket = {
          MULTI_SRT: 0, ELLIPSIS: 0, NOT_FOUND: 0,
          AMBIGUOUS: 0, MISSING_MEANINGFUL: 0, OTHER: 0
        };
        out.set(d.rule, bucket);
      }
      bucket[classifyFailReason(d.reason)]++;
    }
  }
  return out;
}

// BARU: format breakdown. Contoh output:
//   "MULTI_SRT=28 (75.7%)  NOT_FOUND=5 (13.5%)  ELLIPSIS=3 (8.1%)"
function fmtBreakdown(bucket: Record<FailKind, number>): string {
  const total = Object.values(bucket).reduce((a, b) => a + b, 0);
  if (total === 0) return '-';
  const parts = (Object.entries(bucket) as Array<[FailKind, number]>)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v} (${((v / total) * 100).toFixed(1)}%)`);
  return parts.join('  ');
}

// BARU: gabungkan dua bucket (untuk agregasi di printAllTable).
function mergeBreakdown(
  target: Record<FailKind, number>,
  source: Record<FailKind, number>
): void {
  for (const k of Object.keys(source) as FailKind[]) {
    target[k] += source[k];
  }
}

function printRun(res: ReplayResult, full: boolean, currentHash: string): void {
  const { run, chunks, items, notes } = res;
  console.log('='.repeat(78));
  console.log(
    `RUN ${run.run_id}  review=${run.review_id ?? '-'}  ` +
    `code_hash run=${run.code_hash ?? '-'} sekarang=${currentHash}` +
    `${run.code_hash && run.code_hash !== currentHash ? '  (KODE SUDAH BERUBAH)' : ''}`
  );
  console.log(`  aturan assessment sekarang=${RULES_VERSION}  raw_sha=${res.rawSha}`);
  console.log(`  ${REPLAY_SCOPE_NOTE}`);
  for (const n of notes) console.log(`  ! ${n}`);

  console.log(`  ${pad('chunk', 6)}${pad('parsed', 8)}${pad('accept', 8)}${pad('quar', 6)}${pad('parse', 22)}| asli: parsed/accept/quar -> parity`);
  let tp = 0, ta = 0, tq = 0, tf = 0, allSame = true;
  for (const c of chunks) {
    const orig = run.chunks.find(x => x.chunk === c.chunk);
    const same = !!orig && orig.parsed === c.parsed && orig.accepted === c.accepted && orig.quarantine === c.quarantine;
    if (!same) allSame = false;
    tp += c.parsed; ta += c.accepted; tq += c.quarantine; tf += c.flagged;
    console.log(
      `  ${pad(c.chunk, 6)}${pad(c.parsed, 8)}${pad(c.accepted, 8)}${pad(c.quarantine, 6)}` +
      `${pad(`${c.parseStatus}/${c.strategy}`, 22)}| ` +
      `${orig ? `${orig.parsed}/${orig.accepted}/${orig.quarantine}` : '-'} -> ${same ? 'SAMA' : 'BEDA'}` +
      `  ctx=${c.ctx ?? '-'}` +
      `${c.note ? '  ' + c.note : ''}`
    );
  }
  for (const c of chunks) {
    if (!c.diagnosis) continue;
    console.log(`  >> chunk ${c.chunk}: PARSE GAGAL, diagnosis:`);
    for (const d of c.diagnosis) console.log(`       ${d}`);
  }
  for (const c of chunks) {
    if (c.ctx && c.ctx !== 'OK') {
      console.log(`  ~ chunk ${c.chunk}: konteks ${c.ctx}${c.ctxDetail ? ' — ' + c.ctxDetail : ''}`);
    }
  }
  const rate = tp > 0 ? ((tq / tp) * 100).toFixed(1) : '0.0';
  console.log(
    `  TOTAL parsed=${tp} accepted=${ta} (dengan flag=${tf}) quarantine=${tq} (${rate}%)  ` +
    `parity keseluruhan: ${allSame ? 'SAMA' : 'BEDA'}`
  );
  console.log(`  Quarantine per aturan: ${fmtRules(byRule(items))}`);
  console.log(`  Diterima dengan flag per aturan: ${fmtRules(flagsByRule(items))}`);

  // BARU: breakdown GROUNDING/PROVENANCE berdasarkan jenis kegagalan.
  const breakdown = breakdownByRuleAndKind(items);
  for (const ruleName of ['GROUNDING', 'PROVENANCE'] as const) {
    const bucket = breakdown.get(ruleName);
    if (bucket && Object.values(bucket).some(v => v > 0)) {
      console.log(`  Breakdown ${ruleName}: ${fmtBreakdown(bucket)}`);
    }
  }

  const quar = items.filter(i => !i.accepted);
  const shown = full ? quar : quar.slice(0, 40);
    for (const q of shown) {
    console.log(`  [c${q.chunk}#${q.pos}] ${q.blocking.join('+') || '-'} | ${q.type} | sub=${q.subtopic ?? 'null'} | ${trunc(q.claim, 70)}`);
    console.log(`        EXCERPT: ${trunc(q.excerpt, 110)}`);
    console.log(`        ${trunc(q.reason, 150)}`);
  }
  if (!full && quar.length > shown.length) {
    console.log(`  ... ${quar.length - shown.length} item lagi (gunakan --full)`);
  }
  if (full) {
    const flg = items.filter(i => i.accepted && i.flags.length > 0);
    if (flg.length > 0) console.log(`  -- diterima dengan flag (${flg.length}) --`);
    for (const f of flg) {
      console.log(`  [c${f.chunk}#${f.pos}] flag=${f.flags.join('+')} | ${f.type} | ${trunc(f.claim, 70)}`);
    }
    const noCoord = items.filter(i => i.accepted && !i.sourceCoordinates).length;
    console.log(`  Diterima TANPA koordinat/timestamp: ${noCoord}`);
  }
}

function printAllTable(results: ReplayResult[]): void {
  console.log('='.repeat(78));
  console.log(`RINGKASAN SEMUA RUN (hasil replay dengan kode SAAT INI, aturan assessment=${RULES_VERSION})`);
  console.log(REPLAY_SCOPE_NOTE);
  console.log(`${pad('run', 21)}${pad('review', 13)}${pad('parsed', 8)}${pad('accept', 8)}${pad('flag', 6)}${pad('quar', 6)}${pad('rasio', 8)}${pad('gagal-parse', 12)}aturan`);
  const totalRules: Record<string, number> = {};
  const totalFlags: Record<string, number> = {};
  // BARU: agregasi breakdown GROUNDING/PROVENANCE lintas run.
  const totalBreakdown = new Map<string, Record<FailKind, number>>();
  for (const r of results) {
    const tp = r.chunks.reduce((s, c) => s + c.parsed, 0);
    const tq = r.chunks.reduce((s, c) => s + c.quarantine, 0);
    const ta = r.chunks.reduce((s, c) => s + c.accepted, 0);
    const tf = r.chunks.reduce((s, c) => s + c.flagged, 0);
    const rules = byRule(r.items);
    for (const k of Object.keys(rules)) totalRules[k] = (totalRules[k] ?? 0) + rules[k];
    const fl = flagsByRule(r.items);
    for (const k of Object.keys(fl)) totalFlags[k] = (totalFlags[k] ?? 0) + fl[k];
        // BARU: merge breakdown run ini ke agregat.
    for (const [ruleName, bucket] of breakdownByRuleAndKind(r.items)) {
      let agg = totalBreakdown.get(ruleName);
      if (!agg) {
        agg = {
          MULTI_SRT: 0, ELLIPSIS: 0, NOT_FOUND: 0,
          AMBIGUOUS: 0, MISSING_MEANINGFUL: 0, OTHER: 0
        };
        totalBreakdown.set(ruleName, agg);
      }
      mergeBreakdown(agg, bucket);
    }
    console.log(
      `${pad(r.run.run_id.slice(0, 19), 21)}${pad(String(r.run.review_id ?? '-').slice(0, 11), 13)}` +
      `${pad(tp, 8)}${pad(ta, 8)}${pad(tf, 6)}${pad(tq, 6)}${pad(tp ? ((tq / tp) * 100).toFixed(1) + '%' : '-', 8)}` +
      `${pad(r.chunks.filter(c => c.parseStatus === 'FAILED').length + '/' + r.chunks.length, 12)}${fmtRules(rules)}`
    );
  }
  const srtMismatch = results.filter(r => r.srtVerified === false);
  if (srtMismatch.length > 0) {
    console.log(
      `PERINGATAN: ${srtMismatch.length} run isi SRT-nya TIDAK cocok srt_sha tercatat. ` +
      `Terdampak: GROUNDING, PROVENANCE, koordinat. ` +
      `Tidak terdampak (tidak membaca SRT): ASSESSMENT, ATOMICITY, VALUE.`
    );
    for (const r of srtMismatch) {
      console.log(`  - ${r.run.run_id} (srt_sha ${r.run.srt_sha})`);
    }
  }
  const ctxBad = results.filter(r =>
    r.chunks.some(c => c.ctx === 'BOUNDARY_DIFF' || c.ctx === 'CHARS_DIFF'));
  if (ctxBad.length > 0) {
    console.log(
      `PERINGATAN: ${ctxBad.length} run punya chunk yang rekonstruksinya tidak cocok dengan run asli. ` +
      `BOUNDARY_DIFF = batas segmen beda (pasangan raw-konteks tidak terjamin); ` +
      `CHARS_DIFF = panjang teks beda (SRT diedit ATAU format teks chunk berubah).`
    );
    for (const r of ctxBad) {
      const b = r.chunks.filter(c => c.ctx === 'BOUNDARY_DIFF').length;
      const d = r.chunks.filter(c => c.ctx === 'CHARS_DIFF').length;
      console.log(`  - ${r.run.run_id}  BOUNDARY_DIFF=${b}  CHARS_DIFF=${d}  (dari ${r.chunks.length} chunk)`);
    }
  }
  const ctxLegacy = results.filter(r => r.chunks.some(c => c.ctx === 'LEGACY_FORMAT')).length;
  if (ctxLegacy > 0) {
    console.log(
      `Catatan: ${ctxLegacy} run memakai format teks chunk lama (tanpa penanda [N]); ` +
      `batas segmen cocok, panjang cocok dengan format lama (kemungkinan bukan edit SRT).`
    );
  }
  const ctxUnknown = results.filter(r => r.chunks.some(c => c.ctx === 'UNKNOWN')).length;
  if (ctxUnknown > 0) {
    console.log(`Catatan: ${ctxUnknown} run punya chunk dengan verifikasi konteks UNKNOWN (segments/chars tidak tercatat).`);
  }
  console.log(`Total karantina per aturan: ${fmtRules(totalRules)}`);
  console.log(`Total diterima dengan flag per aturan: ${fmtRules(totalFlags)}`);
  // BARU: cetak agregat breakdown.
  for (const ruleName of ['GROUNDING', 'PROVENANCE'] as const) {
    const bucket = totalBreakdown.get(ruleName);
    if (bucket && Object.values(bucket).some(v => v > 0)) {
      console.log(`Total breakdown ${ruleName}: ${fmtBreakdown(bucket)}`);
    }
  }
}

// ------------------------------------------------------------
// Duplicate gate report (mode --duplicates)
// ------------------------------------------------------------
function printDuplicates(res: ReplayResult, full: boolean): void {
  if (!res.duplicates || !res.acceptedForDedup) return;
  const { duplicates, acceptedForDedup } = res;
  const byId = new Map(acceptedForDedup.map(e => [e.evidence_id ?? '', e]));

  console.log('');
  console.log('='.repeat(78));
  console.log(`DUPLICATE GATE — ${res.run.run_id}`);
  console.log(`  Total evidence masuk gate : ${acceptedForDedup.length}`);
  console.log(`  Candidates terdeteksi     : ${duplicates.candidates.length}`);

  const actionCount: Record<string, number> = {};
  for (const p of duplicates.duplicatePairs) {
    actionCount[p.action] = (actionCount[p.action] ?? 0) + 1;
  }
  console.log(
    `  Resolusi per action       : ` +
    (Object.entries(actionCount).map(([k, v]) => `${k}=${v}`).join('  ') || '-')
  );
  console.log('');
  console.log('  Catatan: evidence_id di sini sintetis ("c<chunk>:<pos>"), hanya');
  console.log('  stabil dalam satu replay. Cari berdasarkan excerpt / segmen,');
  console.log('  bukan ID, untuk investigasi lintas-run.');
  console.log('');

  if (duplicates.duplicatePairs.length === 0) {
    console.log('  (tidak ada pair duplikat terdeteksi)');
    return;
  }

  const shown = full
    ? duplicates.duplicatePairs
    : duplicates.duplicatePairs.slice(0, 60);

  for (const pair of shown) {
    const a = byId.get(pair.evidence_id_a);
    const b = byId.get(pair.evidence_id_b);
    console.log(`  ${pair.evidence_id_a} ↔ ${pair.evidence_id_b} | ${pair.action}`);
    if (a) {
      const c = a.source_coordinates;
      console.log(`    A[chunk ${c?.chunk_index ?? '-'} seg ${c?.segment_start_index ?? '-'}] ${trunc(a.source_excerpt ?? '', 90)}`);
    }
    if (b) {
      const c = b.source_coordinates;
      console.log(`    B[chunk ${c?.chunk_index ?? '-'} seg ${c?.segment_start_index ?? '-'}] ${trunc(b.source_excerpt ?? '', 90)}`);
    }
    console.log(`    → ${trunc(pair.reason, 160)}`);
    console.log('');
  }
  if (!full && duplicates.duplicatePairs.length > shown.length) {
    console.log(
      `  ... ${duplicates.duplicatePairs.length - shown.length} pair lagi (gunakan --full)`
    );
  }
}

// ------------------------------------------------------------
// Diff sebelum/sesudah
// ------------------------------------------------------------
function loadSaved(p: string): SavedRun[] {
  const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as SavedRun | SavedRun[];
  return Array.isArray(raw) ? raw : [raw];
}

function printDiff(results: ReplayResult[], prevPath: string, full: boolean, currentHash: string): void {
  const saved = loadSaved(prevPath);
  const byId = new Map(saved.map(s => [s.run_id ?? '', s]));

  const transitions = new Map<string, number>();
  const ruleBefore: Record<string, number> = {};
  const ruleAfter: Record<string, number> = {};
  const tally = { before: { diterima: 0, 'diterima+flag': 0, karantina: 0 }, after: { diterima: 0, 'diterima+flag': 0, karantina: 0 } };
  const flips: string[] = [];
  let compared = 0, inputSame = 0, inputDiff = 0, inputUnknown = 0, missingRuns = 0;
  let configDiff = 0, configUnknown = 0, srtFidelityWarn = 0;
  const beforeVersions = new Set<string>();
  const beforeHashes = new Set<string>();

  console.log('='.repeat(78));
  console.log(`DIFF SEBELUM/SESUDAH terhadap ${prevPath}`);

  for (const res of results) {
    const prev = byId.get(res.run.run_id) ?? (saved.length === 1 && !saved[0].run_id ? saved[0] : undefined);
    if (!prev) { missingRuns++; console.log(`  ? ${res.run.run_id}: tidak ada di file simpanan, dilewati`); continue; }
    compared++;
    beforeVersions.add(prev.rules_version ?? 'legacy/tidak-tercatat');
    if (prev.code_hash) beforeHashes.add(prev.code_hash);

    if (prev.raw_sha && res.rawSha !== '-') {
      if (prev.raw_sha === res.rawSha) inputSame++;
      else { inputDiff++; console.log(`  ! ${res.run.run_id}: raw_sha BEDA (${prev.raw_sha} vs ${res.rawSha}) — file raw berubah, bukan apple-to-apple`); }
    } else {
      inputUnknown++;
    }

    // Fingerprint SRT + konfigurasi chunk (konteks rekonstruksi).
    let runConfigDiff = false;
    let runConfigUnknown = false;

    // (a) Fidelitas terhadap run ASLI: informasional.
    if (res.srtVerified === false) {
      srtFidelityWarn++;
      console.log(
        `  ~ ${res.run.run_id}: isi SRT di disk berbeda dari SRT run ASLI ` +
        `(fidelitas GROUNDING/PROVENANCE terhadap run asli tidak terjamin)`
      );
      // Tanpa srt_content_sha di snapshot, tidak bisa dibuktikan bahwa file
      // belum berubah sejak snapshot.
      if (prev.srt_content_sha == null) runConfigUnknown = true;
    }

    // (b) Snapshot vs sekarang: ini yang memutus apple-to-apple.
    if (prev.srt_content_sha != null && prev.srt_content_sha !== res.srtContentSha) {
      runConfigDiff = true;
      console.log(
        `  ! ${res.run.run_id}: isi file SRT BERUBAH sejak snapshot ` +
        `(${prev.srt_content_sha} -> ${res.srtContentSha ?? '-'}) — bukan apple-to-apple`
      );
    }

    if (prev.srt_sha === undefined) {
      runConfigUnknown = true;
    } else {
      const diffs: string[] = [];
      if (prev.srt_sha !== res.run.srt_sha) {
        diffs.push(`srt_sha ${prev.srt_sha} vs ${res.run.srt_sha}`);
      }
      if ((prev.chunk_chars ?? null) !== (res.run.chunk_chars ?? null)) {
        diffs.push(`chunk_chars ${prev.chunk_chars ?? '-'} vs ${res.run.chunk_chars ?? '-'}`);
      }
      if ((prev.chunk_overlap ?? null) !== (res.run.chunk_overlap ?? null)) {
        diffs.push(`chunk_overlap ${prev.chunk_overlap ?? '-'} vs ${res.run.chunk_overlap ?? '-'}`);
      }
      if (diffs.length > 0) {
        runConfigDiff = true;
        console.log(`  ! ${res.run.run_id}: konfigurasi rekonstruksi BEDA (${diffs.join('; ')}) — bukan apple-to-apple`);
      }
    }

    if (runConfigDiff) configDiff++;
    if (runConfigUnknown) configUnknown++;

    const before = new Map(prev.items.map(i => [i.key, i]));
    const after = new Map(res.items.map(i => [i.key, i]));
    for (const i of prev.items) { tally.before[outcomeOf(i)]++; }
    for (const i of res.items) { tally.after[outcomeOf(i)]++; }
    for (const [r, n] of Object.entries(byRule(prev.items))) ruleBefore[r] = (ruleBefore[r] ?? 0) + n;
    for (const [r, n] of Object.entries(byRule(res.items))) ruleAfter[r] = (ruleAfter[r] ?? 0) + n;

    const tag = `${res.run.run_id.slice(11, 16)}_${String(res.run.review_id ?? '-').slice(0, 6)}`;
    for (const [key, a] of after) {
      const b = before.get(key);
      if (!b) { flips.push(`  + BARU   [${tag} ${key}] ${outcomeOf(a)} | ${trunc(a.claim, 70)}`); continue; }
      const from = outcomeOf(b);
      const to = outcomeOf(a);
      if (from !== to) {
        const k = `${from} -> ${to}`;
        transitions.set(k, (transitions.get(k) ?? 0) + 1);
        flips.push(
          // `flags` bisa tidak ada pada simpanan format lama (sebelum kategori diterima+flag).
          `  ${from} -> ${to}  [${tag} ${key}] ${(b.blocking ?? []).join('+') || (b.flags ?? []).join('+') || '-'} => ` +
          `${(a.blocking ?? []).join('+') || (a.flags ?? []).join('+') || '-'} | ${a.type} | ${trunc(a.claim, 60)}`
        );
      }
    }
    for (const [key, b] of before) {
      if (!after.has(key)) flips.push(`  - HILANG [${tag} ${key}] | ${trunc(b.claim, 70)}`);
    }
  }

  console.log(`  SEBELUM: aturan=${Array.from(beforeVersions).join(',') || '-'}  code_hash=${Array.from(beforeHashes).join(',') || '-'}`);
  console.log(`  SESUDAH: aturan=${RULES_VERSION}  code_hash=${currentHash}`);
  console.log(`  Run dibandingkan: ${compared}${missingRuns ? ` (tidak ada di simpanan: ${missingRuns})` : ''}`);
  if (inputDiff > 0 || configDiff > 0) {
    console.log(
      `  !! INPUT/KONFIGURASI BERBEDA (raw: ${inputDiff} run, SRT/chunk: ${configDiff} run): ` +
      `perbandingan ini BUKAN apple-to-apple.`
    );
  } else if (inputUnknown > 0 && inputSame === 0) {
    console.log('  ?  raw_sha tidak tercatat di simpanan (dibuat replay-run versi lama): kesamaan input tidak terverifikasi.');
  } else if (configUnknown > 0) {
    console.log(
      `  ?  fingerprint SRT/konfigurasi chunk tidak lengkap di simpanan pada ${configUnknown} run ` +
      `(snapshot dibuat sebelum Patch 1/1c): kesamaan konteks rekonstruksi tidak terverifikasi. ` +
      `Buat ulang simpanan dengan --json.`
    );
  } else {
    console.log(
      `  INPUT IDENTIK (raw_sha sama pada ${inputSame} run${inputUnknown ? `; ${inputUnknown} run tanpa raw_sha` : ''}; ` +
      `srt_sha + konfigurasi chunk sama; isi SRT sama dengan saat snapshot): ` +
      `selisih berasal dari kode/aturan saja.`
    );
  }

  if (srtFidelityWarn > 0) {
    console.log(
      `  ~  ${srtFidelityWarn} run: isi SRT berbeda dari run asli (fidelitas terhadap run asli ` +
      `tidak terjamin untuk GROUNDING/PROVENANCE). Ini TIDAK mempengaruhi kesetaraan ` +
      `snapshot vs sekarang.`
    );
  }

  const sum = (t: Record<string, number>) => t.diterima + t['diterima+flag'] + t.karantina;
  console.log('');
  console.log(`  ${pad('', 18)}${pad('sebelum', 10)}${pad('sesudah', 10)}`);
  for (const k of ['diterima', 'diterima+flag', 'karantina'] as const) {
    console.log(`  ${pad(k, 18)}${pad(tally.before[k], 10)}${pad(tally.after[k], 10)}`);
  }
  console.log(`  ${pad('total item', 18)}${pad(sum(tally.before), 10)}${pad(sum(tally.after), 10)}`);

  const rules = Array.from(new Set([...Object.keys(ruleBefore), ...Object.keys(ruleAfter)])).sort();
  if (rules.length > 0) {
    console.log('');
    console.log(`  Karantina per aturan: ${pad('sebelum', 10)}${pad('sesudah', 10)}`);
    for (const r of rules) console.log(`    ${pad(r, 20)}${pad(ruleBefore[r] ?? 0, 10)}${pad(ruleAfter[r] ?? 0, 10)}`);
  }

  if (transitions.size > 0) {
    console.log('');
    console.log('  Perpindahan keputusan:');
    for (const [k, n] of Array.from(transitions).sort((a, b) => b[1] - a[1])) console.log(`    ${pad(k, 34)}${n}`);
  }

  const shown = full ? flips : flips.slice(0, 40);
  if (shown.length > 0) console.log('');
  for (const f of shown) console.log(f);
  if (!full && flips.length > shown.length) console.log(`  ... ${flips.length - shown.length} perubahan lagi (gunakan --full)`);
  if (flips.length === 0) console.log('\n  (tidak ada perubahan keputusan)');
}

// ------------------------------------------------------------
// CLI
// ------------------------------------------------------------
function main(): void {
  const args: string[] = process.argv.slice(2);
  const flag = (name: string) => args.includes(name);

  // Flag yang membawa nilai. Nilainya TIDAK boleh dianggap argumen posisi
  // (bug lama: nilai --filter/--audit/--sample dikira nama run).
  const VALUE_FLAGS = new Set(['--json', '--diff', '--filter', '--audit', '--sample']);

  const valueOf = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) {
      console.error(`${name} membutuhkan sebuah nilai.`);
      process.exit(1);
    }
    return v;
  };

  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) { i++; continue; }  // lewati flag + nilainya
    if (a.startsWith('--')) continue;
    positional.push(a);
  }

  const filterKind = valueOf('--filter') as FailKind | undefined;
    const VALID: FailKind[] = [
    'MULTI_SRT', 'ELLIPSIS', 'NOT_FOUND',
    'AMBIGUOUS', 'MISSING_MEANINGFUL', 'OTHER'
  ];
  if (filterKind && !VALID.includes(filterKind)) {
    console.error(`--filter nilai tidak valid: ${filterKind}. Pilih: ${VALID.join('|')}`);
    process.exit(1);
  }
  const sampleN = Number(valueOf('--sample') ?? '10');

  // Fail-fast: validasi nilai flag SEBELUM replay panjang berjalan.
  const jsonOut = valueOf('--json');
  const diffIn = valueOf('--diff');
  if (diffIn && !fs.existsSync(diffIn)) {
    console.error(`File simpanan tidak ditemukan: ${diffIn}`);
    process.exit(1);
  }

  const auditRule = valueOf('--audit');
  if (auditRule && AUDIT_NOT_EVALUATED.includes(auditRule)) {
    console.error(
      `--audit ${auditRule} tidak didukung: replay tidak mengevaluasi aturan ini ` +
      `(berjalan pasca-duplicate-gate di server.ts). Hasil "0 karantina" akan menyesatkan, ` +
      `jadi diblokir.`
    );
    process.exit(1);
  }
  const AUDIT_RULES_VALID = [
    'ASSESSMENT', 'ATOMICITY', 'VALUE', 'GROUNDING', 'PROVENANCE'
  ];
  if (auditRule && !AUDIT_RULES_VALID.includes(auditRule)) {
    console.error(
      `--audit nilai tidak valid: ${auditRule}. Pilih: ${AUDIT_RULES_VALID.join('|')}`
    );
    process.exit(1);
  }

  const runs = readRuns();
  if (runs.length === 0) {
    console.error(`Tidak ada run di ${path.join(RUN_LOG_DIR, 'runs.jsonl')}.`);
    process.exit(1);
  }

  const replayable = runs.filter(hasRaw);
  if (replayable.length === 0) {
    console.error('Tidak ada run dengan folder raw (hanya run setelah patch run log yang bisa di-replay).');
    process.exit(1);
  }

  let selected: RunRecord[];
  if (flag('--all')) {
    selected = replayable;
  } else if (positional[0]) {
    selected = replayable.filter(r => r.run_id === positional[0] || r.run_id.startsWith(positional[0]));
    if (selected.length === 0) {
      console.error(`Run "${positional[0]}" tidak ditemukan. Tersedia:\n  ` + replayable.map(r => r.run_id).join('\n  '));
      process.exit(1);
    }
  } else {
    selected = [replayable[replayable.length - 1]];
  }

  const currentHash = computeCodeHash();
  const withDuplicates = flag('--duplicates');
  const results = selected.map(r => replayRun(r, withDuplicates));

  if (flag('--all')) {
    printAllTable(results);
    if (flag('--full')) results.forEach(r => printRun(r, true, currentHash));
  } else {
    results.forEach(r => printRun(r, flag('--full'), currentHash));
  }

  if (withDuplicates) {
    results.forEach(r => printDuplicates(r, flag('--full')));
  }

  if (filterKind) {
    printFailureSamples(results, filterKind, flag('--full'), Number.isFinite(sampleN) ? sampleN : 10);
  }

  if (auditRule) {
    printAuditSamples(results, auditRule, flag('--full'), Number.isFinite(sampleN) ? sampleN : 10);
  }

  if (flag('--ambiguous-report')) {
    printAmbiguousReport(
      collectAmbiguous(results),
      flag('--full'),
      Number.isFinite(sampleN) ? sampleN : 10
    );
  }

  if (jsonOut) {
    const toSaved = (r: ReplayResult): SavedRun => ({
      run_id: r.run.run_id,
      code_hash: currentHash,
      rules_version: RULES_VERSION,
      raw_sha: r.rawSha,
      srt_sha: r.run.srt_sha,
      srt_content_sha: r.srtContentSha ?? null,
      chunk_chars: r.run.chunk_chars ?? null,
      chunk_overlap: r.run.chunk_overlap ?? null,
      items: r.items
    });
    const payload = results.length === 1 ? toSaved(results[0]) : results.map(toSaved);
    fs.writeFileSync(jsonOut, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`\nKeputusan per item disimpan ke ${jsonOut} (aturan=${RULES_VERSION}, code_hash=${currentHash})`);
  }

  if (diffIn) {
    printDiff(results, diffIn, flag('--full'), currentHash);
  }
}

main();
