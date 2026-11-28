import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import dotenv from 'dotenv';

// Pasca E3.D
import {
  parseSRT,
  buildEvidenceChunks,
  buildChunkText,
  // parseEvidenceJSON,
  parseEvidenceJSONDetailed,
  buildMetadataContext,
  getReviewerName,
  buildEvidenceInstruction,
  normalizeNullishFields,
  PRODUCTION_SYSTEM_INSTRUCTION_EVIDENCE,
  type ReviewMetadata
} from './src/evidence/production-pipeline';
import { buildSrtNlpSafeInstruction } from './src/prompts/srt-nlp-safe';

// 🔥 IMPOR PROMPT BARU YANG SUDAH DIPISAH
import {
  ANALYSIS_PROMPT_SUMMARY,
  ANALYSIS_PROMPT_EVIDENCE_A
} from './prompts';

// ==========================================
// IMPOR VALIDATOR LAYER PHASE A & B
// ==========================================
import { EvidenceValidator } from './src/evidence/validators/evidence-validator';
// Namespace import: tetap jalan bila assessment.ts belum punya ASSESSMENT_RULES_VERSION (dicatat 'legacy').
import * as assessmentRules from './src/evidence/validators/assessment';
import { TimestampValidator } from './src/evidence/validators/timestamp';
import {
  RelationValidator,
  applyRelationViolations
} from './src/evidence/validators/relation';
import { autoFillRelatedIds } from './src/evidence/validators/relation-autofill';
import { DuplicateValidator } from './src/evidence/validators/duplicate';
import type { DuplicateResult } from './src/evidence/validators/duplicate';
import type {
  EvidenceContext,
  EvidenceItem,
  EvidenceValidationReport
} from './src/evidence/types';
import type { SRTSegment } from './src/evidence/srt';
import {
  buildChunkLocalKeys,
  remapRelatedIds,
  redirectRelatedIds,
  pruneDanglingRelatedIds
} from './src/evidence/related-ids';
import type { LocalKey, ChunkKeyDiagnostics } from './src/evidence/related-ids';
import { normalizeForSearch } from './src/evidence/srt';

// 📦 Impor unified LLM provider
import {
  callLLMAPI,
  callLLMWithFallback,
  getActiveProvider,
  getConfiguredKeyCount
} from './src/llm/llm-provider';

// SRT POST-PROCESSOR
import {
  applyPostNormalize,
  detectCrossSegmentDuplication
} from './src/prompts/srt-post-process';

dotenv.config();
console.log(`🔑 Gemini keys discovered: ${getConfiguredKeyCount()}`);

// Konfigurasi chunking. Dipilih lewat eksperimen 3000/3500/4000/8000 (lihat catatan eksperimen).
const CHUNK_CHARS = Number(process.env.EVIDENCE_CHUNK_CHARS ?? 4000);
const CHUNK_OVERLAP = Number(process.env.EVIDENCE_CHUNK_OVERLAP ?? 2);

const app = express();
const PORT = 3000;
app.use(express.json({ limit: '10mb' }));

// ==========================================
// 1. TIPE DATA & KONFIGURASI TEMPLATE
// ==========================================
interface PromptTemplate {
  id: string;
  name: string;
  instruction: string;
}

let PROMPT_TEMPLATES: PromptTemplate[] = [];
try {
  const templatesData = fs.readFileSync('./promptTemplates.json', 'utf8');
  PROMPT_TEMPLATES = JSON.parse(templatesData) as PromptTemplate[];
} catch (err) {
  console.error('Gagal memuat promptTemplates.json:', err);
}

// Template dinamis dari protection-list.json
const SRT_NLP_SAFE_TEMPLATE: PromptTemplate = {
  id: 'srt_nlp_safe',
  name: '🧬 SRT: NLP-Safe (Evidence-Ready)',
  instruction: buildSrtNlpSafeInstruction()
};

// Guard: hindari duplikat kalau server hot-reload
if (!PROMPT_TEMPLATES.some(t => t.id === SRT_NLP_SAFE_TEMPLATE.id)) {
  PROMPT_TEMPLATES.push(SRT_NLP_SAFE_TEMPLATE);
}

console.log(`📋 Templates loaded: ${PROMPT_TEMPLATES.length}`);
console.log(`   - ${PROMPT_TEMPLATES.map(t => t.id).join('\n   - ')}`);

// ==========================================
// 2. KONFIGURASI KAMUS / DICTIONARY
// ==========================================
const DICTIONARY_DIR = path.join(process.cwd(), 'dictionaries');
if (!fs.existsSync(DICTIONARY_DIR)) {
  fs.mkdirSync(DICTIONARY_DIR, { recursive: true });
  console.log(`✅ Folder dictionaries berhasil dibuat di ${DICTIONARY_DIR}`);
}

function safeReadJSON(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) { return {}; }
  try {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    if (!fileContent || fileContent.trim() === '') { return {}; }
    return JSON.parse(fileContent) as Record<string, string>;
  } catch {
    console.warn(`⚠️ File JSON ${filePath} tidak valid atau rusak, mengabaikan dan memulai baru.`);
    return {};
  }
}

// ==========================================
// 3. HELPER AI FUNCTIONS — SUDAH DIGANTI DENGAN UNIFIED LLM PROVIDER
// ==========================================

// ==========================================
// FUNGSI GENERATE SUMMARY (TERPISAH)
// ==========================================
async function generateSummary(
  srtContent: string,
  metadata: ReviewMetadata = {},
  reviewerName: string = 'Reviewer'
): Promise<string> {
  const segments = parseSRT(srtContent);
  if (segments.length === 0) {
    throw new Error('Format transcript.srt tidak valid atau tidak memiliki segment.');
  }

  const resolvedReviewerName = getReviewerName(metadata, reviewerName);
  const metadataContext = buildMetadataContext(metadata);
  const fullText = segments.map(seg => seg.text).join(' ');

  const summaryInstruction =
    `IDENTITAS REVIEW:\n${metadataContext || `Channel/Reviewer: ${resolvedReviewerName}`}\n\n` +
    `SOURCE OF TRUTH: transcript.srt.\n` +
    `Metadata hanya digunakan untuk identitas review dan konteks administratif.\n` +
    `Jangan menggunakan metadata sebagai evidence isi produk.\n\n` +
    ANALYSIS_PROMPT_SUMMARY;

  // Primary = gemini, fallback = groq
  const result = await callLLMWithFallback(
    fullText,
    summaryInstruction,
    'Anda adalah perangkum produk yang objektif. Gunakan transcript sebagai satu-satunya sumber isi review.',
    'gemini'
  );

  if (!result.success) {
    throw new Error(result.error || 'Gagal mendapatkan summary dari LLM');
  }
  return result.content;
}

// ==========================================
// RUN FINGERPRINT & RUN LOG
// ==========================================
// Tujuan: setiap run bisa dibandingkan dengan run lain. Yang dicatat:
//   - identitas kode (git commit + dirty + hash isi file kunci),
//   - hash prompt evidence & system instruction,
//   - tabel per chunk (parsed / accepted / quarantine / status / panjang output),
//   - output mentah LLM per chunk (untuk replay validator tanpa API).
// Nonaktifkan dengan EVIDENCE_RUN_LOG=0. Lokasi: EVIDENCE_RUN_LOG_DIR (default ./runs).
// Tambahkan "runs/" ke .gitignore.
// ==========================================

const RUN_LOG_ENABLED = process.env.EVIDENCE_RUN_LOG !== '0';
const RUN_LOG_DIR = path.resolve(process.env.EVIDENCE_RUN_LOG_DIR ?? './runs');

function shortHash(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 8);
}

// Hash isi file kode kunci: tetap membedakan versi kode walau working tree
// belum di-commit (commit hash saja tidak cukup saat banyak perubahan lokal).
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
    } catch { /* file tidak ada: lewati */ }
  }
  return h.digest('hex').slice(0, 8);
}

// git_dirty hanya menghitung file TERLACAK yang berubah (runs/ dan file lepas
// tidak membuatnya selalu true); isi file kunci sudah tercakup code_hash.
function readGitInfo(): { git_commit: string; git_dirty: boolean | null } {
  try {
    const opts = { stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] };
    const commit = execSync('git rev-parse --short HEAD', opts).toString().trim();
    const dirty = execSync('git status --porcelain --untracked-files=no', opts).toString().trim().length > 0;
    return { git_commit: commit, git_dirty: dirty };
  } catch {
    return { git_commit: 'unknown', git_dirty: null };
  }
}

// Dihitung sekali saat server start.
// Label versi aturan ASSESSMENT (lihat riwayat versi di assessment.ts). Dicatat di tiap run
// supaya run dengan kebijakan berbeda tidak dibandingkan seolah apple-to-apple.
const RULES_VERSION: string =
  (assessmentRules as unknown as { ASSESSMENT_RULES_VERSION?: string }).ASSESSMENT_RULES_VERSION ?? 'legacy';

const RUN_FINGERPRINT = {
  ...readGitInfo(),
  code_hash: computeCodeHash(),
  prompt_hash: shortHash(ANALYSIS_PROMPT_EVIDENCE_A),
  system_hash: shortHash(PRODUCTION_SYSTEM_INSTRUCTION_EVIDENCE)
};

interface ChunkRunRecord {
  chunk: number;                 // 1-based
  segments: [number, number];    // indeks segmen pertama..terakhir
  chars: number;                 // panjang input chunk
  model: string | null;
  // PARSE_FAILED: LLM menjawab tetapi JSON gagal diparse -> chunk TIDAK menghasilkan evidence.
  status: 'OK' | 'EMPTY' | 'FAILED' | 'PARSE_FAILED';
  // Jumlah field berisi string kosong/"null" yang dinormalisasi ke null.
  nullish_normalized?: number;
  // Dari accepted: berapa yang membawa aturan non-PASS yang tidak memblokir (SUSPECT LOW/MEDIUM).
  flagged?: number;
  // Terisi bila JSON rusak dan parser memakai penyelamatan per objek.
  salvage?: { recovered: number; repaired: number; skipped: number; truncated: boolean };
  error?: string;
  raw_chars: number | null;      // panjang output mentah LLM (deteksi pemotongan)
  parse_status: string | null;
  parse_strategy: string | null;
  parsed: number;
  accepted: number;
  quarantine: number;
}

interface RunInfo {
  run_id: string;
  review_id: string | null;
  srt_sha: string;
  chunk_chars: number;
  chunk_overlap: number;
  chunks: ChunkRunRecord[];
}

function saveRunArtifact(dir: string | null, name: string, content: string): void {
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  } catch (err) {
    console.warn(`⚠️ Gagal menyimpan ${name}:`, (err as Error)?.message);
  }
}

// Satu baris ringkas ke konsol (seperti sebelumnya + identitas run) dan
// satu baris lengkap (dengan tabel per chunk) ke runs/runs.jsonl.
function logRunLine(
  endpoint: string,
  stats: Awaited<ReturnType<typeof extractEvidence>>['stats'],
  runInfo: RunInfo
): void {
  const core = {
    ts: new Date().toISOString(),
    endpoint,
    prompt_version: 'A',

    // Extraction funnel.
    parsed_evidence: stats.parsedEvidenceCount,
    structurally_invalid: stats.structurallyInvalidCount,
    validator_accepted: stats.validatorAcceptedCount,
    quarantine: stats.quarantineCount,
    // Diterima tetapi ditandai (aturan non-PASS tidak memblokir). Sejak assessment-v2 angka karantina
    // saja tidak lagi mengukur ketegasan gatekeeper; pantau juga angka ini.
    accepted_flagged: runInfo.chunks.reduce((n, c) => n + (c.flagged ?? 0), 0),
    rules_version: RULES_VERSION,

    // Duplicate funnel.
    duplicate_removed: stats.duplicateRemovedCount,
    duplicate_merged: stats.duplicateMergedCount,
    final_evidence: stats.finalCount,

        // Multi-occurrence telemetry.
    eligible_multi: stats.eligibleMultiCount,
    resolved_multi: stats.resolvedMultiCount,
    quarantine_multi: stats.quarantineMultiCount,
    multi_resolution_rate: stats.multiResolutionRate,
    multi_quarantine_rate: stats.multiQuarantineRate,

    // Relation telemetry (rule 19).
    relation_flagged: stats.relationFlaggedCount,
    relation_expected_pairs: stats.relationExpectedPairs,
    relation_linked_pairs: stats.relationLinkedPairs,
    relation_link_rate: stats.relationLinkRate
  };

  const failedChunks = runInfo.chunks
    .filter(c => c.status === 'FAILED' || c.status === 'PARSE_FAILED')
    .map(c => c.chunk);
  console.log(JSON.stringify({
    ...core,
    run_id: runInfo.run_id,
    git_commit: RUN_FINGERPRINT.git_commit,
    git_dirty: RUN_FINGERPRINT.git_dirty,
    code_hash: RUN_FINGERPRINT.code_hash,
    failed_chunks: failedChunks
  }));

  if (!RUN_LOG_ENABLED) return;
  try {
    fs.mkdirSync(RUN_LOG_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(RUN_LOG_DIR, 'runs.jsonl'),
      JSON.stringify({ ...core, ...RUN_FINGERPRINT, ...runInfo }) + '\n',
      'utf8'
    );
  } catch (err) {
    console.warn('⚠️ Gagal menulis runs.jsonl:', (err as Error)?.message);
  }
}

// ==========================================
// FUNGSI EXTRACT EVIDENCE (TERPISAH)
// ==========================================

async function extractEvidence(
  srtContent: string,
  metadata: ReviewMetadata = {},
  reviewerName: string = 'Reviewer'
): Promise<{
  evidence: EvidenceItem[];
  quarantine: Array<{ evidence: EvidenceItem; reason?: string; chunkIndex: number }>;
  duplicateRemoved: Array<{ evidence_id: string; reason: string; kept_evidence_id: string }>;
  duplicateMerged: Array<{ evidence_id_a: string; evidence_id_b: string; merged_evidence_id: string; reason: string }>;
  stats: {
    parsedEvidenceCount: number;
    structurallyInvalidCount: number;
    validatorAcceptedCount: number;
    quarantineCount: number;
    duplicateRemovedCount: number;
    duplicateMergedCount: number;
    finalCount: number;
    eligibleMultiCount: number;
    resolvedMultiCount: number;
    quarantineMultiCount: number;
    multiResolutionRate: number | null;
    multiQuarantineRate: number | null;
    // ── Relation telemetry (rule 19) ────────────────────────
    // Dipakai untuk memantau apakah model sudah mengisi
    // related_evidence_ids sesuai rule 19. Severity RELATION
    // adalah MEDIUM (non-blocking), jadi angka ini adalah
    // satu-satunya sinyal kuantitatif untuk menilai kepatuhan.
    relationFlaggedCount: number;
    relationExpectedPairs: number;
    relationLinkedPairs: number;
    /** relationLinkedPairs / relationExpectedPairs, null bila expected=0. */
    relationLinkRate: number | null;
    promptVersion: 'A';
  };
  runInfo: RunInfo;
}> {
  // Parse SRT
  const segments = parseSRT(srtContent);
  if (segments.length === 0) {
    throw new Error('Format transcript.srt tidak valid atau tidak memiliki segment.');
  }

  const resolvedReviewerName = getReviewerName(metadata, reviewerName);
  const metadataContext = buildMetadataContext(metadata);

  const evidenceChunks = buildEvidenceChunks(segments, CHUNK_CHARS, CHUNK_OVERLAP);
  console.log(`📦 Evidence extraction akan menggunakan ${evidenceChunks.length} chunk.`);

  // Identitas run + tabel per chunk (lihat RUN FINGERPRINT & RUN LOG).
  const srtSha = shortHash(srtContent);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}_${metadata.id ?? 'noid'}`;
  const runDir = RUN_LOG_ENABLED ? path.join(RUN_LOG_DIR, runId) : null;
  const chunkRecords: ChunkRunRecord[] = [];
  if (RUN_LOG_ENABLED) {
    // SRT disimpan sekali per isi (dedup lewat hash) untuk replay.
    const srtPath = path.join(RUN_LOG_DIR, '_srt', `${srtSha}.srt`);
    try {
      if (!fs.existsSync(srtPath)) {
        fs.mkdirSync(path.dirname(srtPath), { recursive: true });
        fs.writeFileSync(srtPath, srtContent, 'utf8');
      }
    } catch (err) {
      console.warn('⚠️ Gagal menyimpan SRT run:', (err as Error)?.message);
    }
  }

  let allEvidence: EvidenceItem[] = [];
  // Array paralel dengan allEvidence (indeks sama): nomor LOKAL LLM tiap item
  // yang lolos validasi. Dipakai untuk memetakan related_evidence_ids.
  const allEvidenceKeys: LocalKey[] = [];
  const chunkKeyDiagnostics: ChunkKeyDiagnostics[] = [];
  // ==========================================================
  // EXTRACTION TELEMETRY
  // ==========================================================
  // parsedEvidenceCount:
  //   Semua item yang berhasil diparse dari output JSON LLM.
  //
  // structurallyInvalidCount:
  //   Item hasil parse yang tidak memenuhi bentuk dasar evidence
  //   (misalnya tidak memiliki claim string yang valid).
  //
  // validatorAcceptedCount:
  //   Evidence yang lolos EvidenceValidator.
  //
  // quarantineCount:
  //   Evidence yang berhasil diparse tetapi ditolak validator.
  //
  // Statistik ini sengaja dipisahkan dari duplicate gate.
  // ==========================================================

  let parsedEvidenceCount = 0;
  let structurallyInvalidCount = 0;
  let validatorAcceptedCount = 0;
  let quarantineSequence = 0;
  let globalEvidenceCounter = 0;
  const quarantinedEvidence: Array<{
    evidence: EvidenceItem;
    reason?: string;
    chunkIndex: number;
  }> = [];
  let eligibleMultiCount = 0;
  let resolvedMultiCount = 0;
  let quarantineMultiCount = 0;

  // Loop per chunk
  for (let chunkIndex = 0; chunkIndex < evidenceChunks.length; chunkIndex++) {
    const chunk = evidenceChunks[chunkIndex];
    const batchNumber = chunkIndex + 1;
    const totalBatches = evidenceChunks.length;

    const evidenceInstruction = buildEvidenceInstruction(
      metadata,
      reviewerName,
      batchNumber,
      totalBatches,
      ANALYSIS_PROMPT_EVIDENCE_A
    );

    console.log(`📦 Mengekstrak Chunk Evidence ke-${batchNumber}/${totalBatches} ...`);

    // 🔥 LOG RENTANG SEGMEN
    const firstSegment = chunk[0];
    const lastSegment = chunk[chunk.length - 1];
    const totalSegments = chunk.length;
    console.log(
      `   📍 Segmen ${firstSegment.index} → ${lastSegment.index} ` +
      `(${firstSegment.start} → ${lastSegment.end})`
    );
    console.log(`   📏 Jumlah segmen: ${totalSegments}`);

    // 🔥 BUILD CHUNK TEXT DAN HITUNG KARAKTER
    const chunkText = buildChunkText(chunk);
    const charLength = chunkText.length;
    console.log(`📏 Chunk ${batchNumber} - Karakter: ${charLength}, Estimasi Token: ~${Math.ceil(charLength / 4)}`);

    const rec: ChunkRunRecord = {
      chunk: batchNumber,
      segments: [firstSegment.index, lastSegment.index],
      chars: charLength,
      model: null,
      status: 'FAILED',
      raw_chars: null,
      parse_status: null,
      parse_strategy: null,
      parsed: 0,
      accepted: 0,
      quarantine: 0
    };
    chunkRecords.push(rec);
    const accStart = allEvidence.length;
    const quarStart = quarantinedEvidence.length;

    try {
      const result = await callLLMWithFallback(
        chunkText,
        evidenceInstruction,
        PRODUCTION_SYSTEM_INSTRUCTION_EVIDENCE,
        'gemini'
      );

      if (!result.success) {
        throw new Error(result.error || 'Gagal mengekstrak evidence dari LLM');
      }

      const rawOutput = result.content;
      rec.model = result.model ?? null;
      rec.raw_chars = rawOutput.length;
      saveRunArtifact(runDir, `chunk-${batchNumber}.raw.txt`, rawOutput);
      // const chunkEvidence = parseEvidenceJSON(rawOutput);
      // Pakai versi detailed agar strategi fallback yang berhasil bisa
      // dilog. Perilaku parsing IDENTIK dengan parseEvidenceJSON --
      // parseEvidenceJSONDetailed memanggil core yang sama (lihat
      // production-pipeline.ts) -- ini murni menambah observability.
      const parsedResult = parseEvidenceJSONDetailed(rawOutput);
      const chunkEvidence = parsedResult.evidence as EvidenceItem[];
      rec.parse_status = String(parsedResult.status);
      rec.parse_strategy = String(parsedResult.strategy);
      rec.parsed = chunkEvidence.length;
      if (parsedResult.strategy === 'object_salvage' && parsedResult.salvage) {
        const sv = parsedResult.salvage;
        rec.salvage = sv;

        const attempted = sv.recovered + sv.skipped;
        const skipRatio = attempted > 0 ? sv.skipped / attempted : 0;

        // Tier log berdasarkan severity:
        //   - skipRatio < 10%  : salvage ringan, informational
        //   - skipRatio 10-30% : salvage berat, warning standar
        //   - skipRatio > 30%  : data loss signifikan, alert (potensi retry)
        if (skipRatio > 0.30) {
          console.error(
            `🔴 Chunk ke-${batchNumber}: SALVAGE CRITICAL — ${sv.skipped}/${attempted} ` +
            `item hilang (${(skipRatio * 100).toFixed(0)}%). ` +
            `Repaired: ${sv.repaired}, Truncated: ${sv.truncated}. ` +
            `Pertimbangkan retry chunk ini atau investigate raw output.`
          );
        } else if (skipRatio > 0.10) {
          console.warn(
            `⚠️ Chunk ke-${batchNumber}: heavy salvage — ${sv.skipped}/${attempted} ` +
            `item hilang (${(skipRatio * 100).toFixed(0)}%). ` +
            `Repaired: ${sv.repaired}.`
          );
        } else {
          console.warn(
            `⚠️ Chunk ke-${batchNumber}: JSON rusak, ${sv.recovered} item diselamatkan ` +
            `(${sv.repaired} diperbaiki, ${sv.skipped} dilewati${sv.truncated ? ', output terpotong' : ''}).`
          );
        }
      }
      if (parsedResult.status === 'FAILED') {
        rec.status = 'PARSE_FAILED';
        console.warn(
          `⚠️ Chunk ke-${batchNumber}: parse JSON GAGAL (output mentah ${rawOutput.length} karakter) -- ` +
          `chunk ini TIDAK menghasilkan evidence. Diagnosis: npx tsx scripts/replay-run.ts <run_id>`
        );
      }

      // Nomor lokal LLM dihitung dari SEMUA item hasil parse, sebelum filter
      // struktural/validator, karena LLM menomori urutan keluarannya sendiri.
      // Metadata ID (model vs auto-fill) diteruskan untuk diagnosis collision.
      const { keys: chunkKeys, diagnostics: chunkKeyDiag } =
        buildChunkLocalKeys(
          chunkEvidence as any[],
          chunkIndex,
          parsedResult.idMetadata
        );
      chunkKeyDiagnostics.push(chunkKeyDiag);
      console.log(

        `   🔢 Chunk ${chunkIndex + 1}: ${chunkKeyDiag.totalParsed} item parse, nomor lokal ` +
        `${chunkKeyDiag.idRange ? chunkKeyDiag.idRange.join('..') : '-'} [${chunkKeyDiag.mode}/${chunkKeyDiag.reason}]`
      );
      // empty-chunk (0 item parse): tidak ada yang dinomori, jadi bukan masalah
      // penomoran. Peringatan PARSE_FAILED/EMPTY di bawah sudah menandai chunk-nya.
      if (chunkKeyDiag.mode === 'position' && chunkKeyDiag.reason !== 'empty-chunk') {
        console.warn(
          `⚠️ Chunk ${chunkIndex + 1}: nomor lokal memakai posisi (alasan: ${chunkKeyDiag.reason}, ` +
          `id hilang: ${chunkKeyDiag.missingIds}, id ganda: ${chunkKeyDiag.duplicateIds.join(',') || '-'})`
        );
      }
            // Log berapa ID yang diisi parser (bukan dari model) — observability.
      if (chunkKeyDiag.autoFilledCount > 0) {
        console.warn(
          `⚠️ Chunk ${chunkIndex + 1}: ${chunkKeyDiag.autoFilledCount}/` +
          `${chunkKeyDiag.totalParsed} evidence tanpa evidence_id dari model ` +
          `(di-auto-fill dengan posisi).`
        );
      }
      const keyByEv = new Map<unknown, LocalKey>();
      chunkEvidence.forEach((e, i) => keyByEv.set(e, chunkKeys[i]));

      // Semua item yang berhasil diparse dari JSON LLM.
      parsedEvidenceCount += chunkEvidence.length;

      // Validitas struktural saja.
      // Ini BELUM berarti evidence lolos EvidenceValidator.
      const structurallyValidEvidence =
        chunkEvidence.filter(isValidEvidence);

      structurallyInvalidCount +=
        chunkEvidence.length - structurallyValidEvidence.length;

      if (structurallyValidEvidence.length === 0) {
        console.log(`⚠️ Chunk ke-${batchNumber} tidak menghasilkan evidence valid.`);
        if (rec.status !== 'PARSE_FAILED') rec.status = 'EMPTY';
        continue;
      }

      let nullishFixed = 0;
      let flaggedCount = 0;
      for (const ev of structurallyValidEvidence) {
        // Tambahkan ini untuk menomori evidence secara global
        globalEvidenceCounter++;
        const globalId = `E${String(globalEvidenceCounter).padStart(3, '0')}`;

        const context: EvidenceContext = {
          chunkIndex,
          chunkText,
          chunkSegments: chunk,
          allSegments: segments
        };

        // ▼ Normalisasi string kosong/"null" -> null (sebelum reconcile & validasi)
        nullishFixed += normalizeNullishFields(ev);

        // ▼ Auto-reconcile sebelum validasi
        const reconciledEv = reconcileTypeWithAssessment(ev);

        function reconcileTypeWithAssessment(ev: EvidenceItem): EvidenceItem {
          const hasAssessment =
            ev.reviewer_assessment !== null &&
            ev.reviewer_assessment !== undefined &&
            String(ev.reviewer_assessment).trim() !== '';

          const normalizedType = (ev.type || '').toUpperCase();

          if (hasAssessment && normalizedType !== 'OPINION') {
            console.warn(
              `🔧 Auto-upgrade type: ${normalizedType} → OPINION ` +
              `(assessment="${ev.reviewer_assessment}" filled but type was non-OPINION). ` +
              `Claim: "${ev.claim}"`
            );
            return { ...ev, type: 'OPINION' };
          }
          return ev;
        }

        const report: EvidenceValidationReport = EvidenceValidator.validate(reconciledEv, context);

        // Normalisasi simetris kedua sisi (Concern 1)
        const occCount = countOccurrences(
          normalizeForSearch(ev.source_excerpt || ''),
          normalizeForSearch(chunkText)
        );

        // eligible_multi dihitung sebelum accepted check (Concern 2, align Option X)
        const isMulti = occCount >= 2;
        if (isMulti) eligibleMultiCount++;

        if (report.accepted) {
          validatorAcceptedCount++;
          // Diterima tetapi membawa aturan non-PASS yang tidak memblokir (mis. ASSESSMENT SUSPECT LOW).
          if (report.results.some(r => r.status !== 'PASS')) flaggedCount++;

          allEvidence.push({
            ...reconciledEv,
            evidence_id: globalId,
            validation: report
          });
          allEvidenceKeys.push(keyByEv.get(ev)!);
          if (isMulti) {
            // FIX: count accepted multi items as resolved regardless of PROVENANCE
            // strict PASS vs SUSPECT MEDIUM. Accounting invariant:
            //   eligible = resolved + quarantine
            //
            // Rationale: SUSPECT MEDIUM (short excerpt <20 char, non-blocking)
            // still results in an accepted evidence. From the metric's perspective,
            // the item is "resolved enough" (not blocked). Consumers who need
            // strict disambiguation can inspect report.results for PROVENANCE
            // SUSPECT status.
            resolvedMultiCount++;
          }
        } else {
          quarantineSequence++;
          
          quarantinedEvidence.push({
            evidence: { 
              ...reconciledEv, // Gunakan versi reconciled
              evidence_id: `Q${String(quarantineSequence).padStart(3, '0')}`,
              original_id: globalId,
              validation: report // <-- Simpan hasil validator!
            },
            reason: report.quarantineReason,
            chunkIndex
          });
          if (isMulti) quarantineMultiCount++;
        }
      } // ← tutup loop for (const ev of structurallyValidEvidence)

      if (nullishFixed > 0) {
        rec.nullish_normalized = nullishFixed;
        console.warn(
          `⚠️ Chunk ke-${batchNumber}: ${nullishFixed} field berisi string kosong/"null" ` +
          `dinormalisasi ke null (format keluaran model menyimpang dari skema).`
        );
      }

      if (rec.status !== 'PARSE_FAILED') {
        rec.status = 'OK';
      }
      rec.flagged = flaggedCount;
      rec.accepted = allEvidence.length - accStart;
      rec.quarantine = quarantinedEvidence.length - quarStart;
      console.log(`✅ Chunk ke-${batchNumber} selesai. Total valid: ${allEvidence.length}, Quarantine: ${quarantinedEvidence.length}`);
    } catch (err) {
      console.error(`❌ Gagal memproses Chunk ke-${batchNumber}:`, err);
      rec.status = 'FAILED';
      rec.error = String((err as Error)?.message ?? err).slice(0, 200);
      rec.accepted = allEvidence.length - accStart;
      rec.quarantine = quarantinedEvidence.length - quarStart;
      continue;
    }

    // Jeda 5 detik agar tidak kena rate limit Groq (meskipun primary gemini, fallback tetap groq)
    if (chunkIndex < evidenceChunks.length - 1) {
      console.log(`⏳ Menunggu 5 detik sebelum chunk berikutnya...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  // ==========================================================
  // STATISTICAL INVARIANT
  // ==========================================================
  // Semua structurally-valid parsed evidence harus berakhir
  // tepat di salah satu dari dua jalur:
  //   1. validator accepted
  //   2. quarantine
  //
  // Jika invariant gagal, berarti ada evidence yang hilang
  // di antara structural gate dan validator.
  // ==========================================================

  const validatorCandidateCount =
    validatorAcceptedCount + quarantinedEvidence.length;

  const expectedValidatorCandidateCount =
    parsedEvidenceCount - structurallyInvalidCount;

  if (validatorCandidateCount !== expectedValidatorCandidateCount) {
    console.error(
      `❌ STAT INVARIANT FAILED: ` +
      `validator candidates=${validatorCandidateCount}, ` +
      `expected=${expectedValidatorCandidateCount}, ` +
      `parsed=${parsedEvidenceCount}, ` +
      `structurallyInvalid=${structurallyInvalidCount}`
    );
  } else {
    console.log(
      `📊 Extraction invariant PASS: ` +
      `${parsedEvidenceCount} parsed → ` +
      `${structurallyInvalidCount} structurally invalid + ` +
      `${validatorAcceptedCount} accepted + ` +
      `${quarantinedEvidence.length} quarantine`
    );
  }

  // Assign ID
  const identifiedEvidenceRaw = assignEvidenceIds(allEvidence, metadata.id ?? null);

  // Petakan related_evidence_ids (nomor lokal LLM) -> evidence_id final
  const { evidence: identifiedEvidence, stats: relatedStats } =
    remapRelatedIds(identifiedEvidenceRaw, allEvidenceKeys, chunkKeyDiagnostics);
  console.log(
    `🔗 related_evidence_ids: ${relatedStats.mapped}/${relatedStats.totalRefs} dipetakan, ` +
    `dibuang: ${relatedStats.droppedUnknown} tak dikenal, ${relatedStats.droppedSelf} diri sendiri, ` +
    `${relatedStats.droppedDuplicate} ganda | nomor lokal: ` +
    `${relatedStats.chunksUsingLlmIds} chunk dari evidence_id LLM, ` +
    `${relatedStats.chunksUsingPosition} chunk dari posisi`
  );
  for (const c of relatedStats.perChunk) {
    console.log(
      `   🔗 Chunk ${c.chunkIndex + 1} [${c.mode}/${c.reason}]: ${c.itemsAccepted} item, ` +
      `${c.emitted} ref → ${c.mapped} dipetakan | dibuang: ${c.droppedTargetRemoved} ke item terbuang, ` +
      `${c.droppedTargetNonexistent} nomor tak ada, ${c.droppedTargetUnclassified} tak terklasifikasi, ` +
      `${c.droppedUnparseable} tak terbaca`
    );
    for (const sm of c.samples) {
      console.log(`      · ${sm.from} → "${sm.ref}" (${sm.reason})`);
    }
  }
  console.log(`🏷️ Evidence ID telah di-assign: ${identifiedEvidence.length} evidence.`);

  // Duplicate Gate
  const duplicateResult = DuplicateValidator.detect(identifiedEvidence);
  const { preservedEvidence, duplicateRemovedDetails, duplicateMergedDetails } =
    resolveDuplicateActions(identifiedEvidence, duplicateResult, segments);

  console.log(`🧹 Duplicate gate selesai: ${identifiedEvidence.length} -> ${preservedEvidence.length}`);

  // Tambahkan timestamp & metadata
  // Arahkan referensi yang menunjuk item duplikat/merge ke id final
  const { evidence: relinkedEvidence, dropped: relatedDropped } =
    redirectRelatedIds(preservedEvidence, duplicateRemovedDetails, duplicateMergedDetails);
  if (relatedDropped > 0) {
    console.log(`🔗 ${relatedDropped} referensi related_evidence_ids dibuang/diarahkan ulang setelah duplicate gate.`);
  }

  // ── Timestamp generation + validation (post-process) ─────────
  // Timestamp di-generate dari source_coordinates, lalu divalidasi
  // konsistensinya oleh TimestampValidator. Evidence yang gagal
  // (mismatch / orphan / koordinat invalid) dipindahkan ke
  // quarantinedEvidence, bukan diteruskan ke output final.
  //
  // Ini menutup gap yang tidak tertangani 5 validator lain:
  // mereka tidak menerima timestamp sebagai input. Kasus E149
  // (source_coordinates.segment_start_index=260 tapi timestamp
  // milik segmen 259) hanya bisa ditangkap di sini.
  const finalEvidence: EvidenceItem[] = [];
  let timestampQuarantinedCount = 0;

  for (const ev of relinkedEvidence) {
    const timestamp = ev.source_coordinates
      ? getTimestampFromCoordinates(ev.source_coordinates, segments)
      : { timestamp_start: null, timestamp_end: null };

    const withMetadata: EvidenceItem = {
      ...ev,
      timestamp_start: timestamp.timestamp_start,
      timestamp_end: timestamp.timestamp_end,
      source: resolvedReviewerName,
      review_id: metadata.id ?? null,
      video_url: metadata.url ?? null,
      video_title: metadata.title ?? null
    };

    const tsResult = TimestampValidator.validate(withMetadata, segments);

    // Append hasil TIMESTAMP ke validation.results supaya terlihat
    // di audit trail (sama seperti rule lain).
    const existingValidation = withMetadata.validation;
    const updatedValidation = existingValidation
      ? {
          ...existingValidation,
          results: [...existingValidation.results, tsResult],
          accepted: existingValidation.accepted && tsResult.pass,
          finalStatus: tsResult.pass
            ? existingValidation.finalStatus
            : ('QUARANTINE' as const),
          quarantineReason: tsResult.pass
            ? existingValidation.quarantineReason
            : `TIMESTAMP: ${tsResult.reason ?? 'timestamp mismatch'}`
        }
      : undefined;

    const finalEv: EvidenceItem = { ...withMetadata, validation: updatedValidation };

    if (tsResult.pass) {
      finalEvidence.push(finalEv);
    } else {
      timestampQuarantinedCount++;
      quarantineSequence++;
      quarantinedEvidence.push({
        evidence: {
          ...finalEv,
          evidence_id: `Q${String(quarantineSequence).padStart(3, '0')}`
        },
        reason: `TIMESTAMP: ${tsResult.reason ?? 'timestamp mismatch'}`,
        chunkIndex: ev.source_coordinates?.chunk_index ?? -1
      });
    }
  }

  if (timestampQuarantinedCount > 0) {
    console.warn(
      `⚠️ Timestamp validation: ${timestampQuarantinedCount} evidence ` +
      `dipindahkan ke quarantine (source_coordinates ada tapi timestamp ` +
      `tidak konsisten dengan SRT).`
    );
  }

    // ── Bersihkan referensi menggantung setelah timestamp gate ──
  // Evidence yang masuk quarantine karena timestamp sudah keluar dari
  // finalEvidence, tetapi evidence lain mungkin masih merujuknya.
  // Hanya referensi yang dibuang; evidence perujuk TIDAK dikarantina.
  // splice dipakai agar variabel finalEvidence yang dipakai hilir
  // (autoFill, RelationValidator) tidak perlu diganti.
  {
    const pruned = pruneDanglingRelatedIds(finalEvidence);
    if (pruned.dropped > 0) {
      console.log(
        `🔗 ${pruned.dropped} referensi related_evidence_ids ke evidence yang ` +
        `tidak ada di hasil akhir dibuang (timestamp gate).`
      );
      finalEvidence.splice(0, finalEvidence.length, ...pruned.evidence);
    }
  }

  // ── Relation auto-fill (post-process, lintas-chunk) ────────
  // Lengkapi related_evidence_ids untuk pola lintas-chunk yang
  // tidak mungkin diisi model saat ekstraksi (chunk 0 tidak tahu
  // akan ada fps Genshin di chunk 6). Auto-fill HANYA menambah
  // ref yang belum ada; tidak menghapus ref yang sudah diisi model.
  //
  // Dijalankan SEBELUM RelationValidator.detect, sehingga hasil
  // validasi mencerminkan state setelah auto-fill.
  const autoFillStats = autoFillRelatedIds(finalEvidence);
  if (
    autoFillStats.presetLinksAdded > 0 ||
    autoFillStats.conditionLinksAdded > 0
  ) {
    console.log(
      `🔗 Relation auto-fill: +${autoFillStats.presetLinksAdded} link preset↔fps, ` +
      `+${autoFillStats.conditionLinksAdded} link kondisi-beda, ` +
      `${autoFillStats.evidenceTouched} evidence disentuh.`
    );
  }

  // ── Relation validation (global pass) ──────────────────────
  // Setelah semua validator per-evidence selesai dan timestamp
  // tervalidasi, jalankan global pass untuk menegakkan rule 19:
  // related_evidence_ids WAJIB diisi untuk pola-pola tertentu
  // (preset ↔ hasil, kondisi berbeda). Berbeda dari 5 validator
  // lain, RELATION butuh akses ke seluruh daftar evidence untuk
  // mencari pasangan yang seharusnya bertaut.
  //
  // Severity MEDIUM (non-blocking): evidence tetap diterima, hanya
  // ditandai finalStatus=VALID_WITH_NORMALIZATION. Konservatif
  // karena ini validator baru; severity bisa dinaikkan setelah ada
  // data produksi.
  const relationResult = RelationValidator.detect(finalEvidence);
  const {
    evidenceList: finalEvidenceWithRelations,
    flagged: relationFlagged
  } = applyRelationViolations(finalEvidence, relationResult);

  if (relationFlagged > 0) {
    console.warn(
      `⚠️ Relation validation: ${relationFlagged} evidence ditandai ` +
      `(rule 19: related_evidence_ids tidak lengkap). ` +
      `expected_pairs=${relationResult.expectedPairs}, ` +
      `linked_pairs=${relationResult.linkedPairs}.`
    );
    for (const v of relationResult.violations.slice(0, 10)) {
      console.warn(`   · ${v.evidence_id}: [${v.rule}] ${v.reason}`);
    }
    if (relationResult.violations.length > 10) {
      console.warn(
        `   · ... dan ${relationResult.violations.length - 10} violation lainnya`
      );
    }
  }

  const duplicateRemovedCount = duplicateRemovedDetails.length;
  const mergedCount = duplicateMergedDetails.length;

  const runInfo: RunInfo = {
    run_id: runId,
    review_id: metadata.id ?? null,
    srt_sha: srtSha,
    chunk_chars: CHUNK_CHARS,
    chunk_overlap: CHUNK_OVERLAP,
    chunks: chunkRecords
  };

  return {
    evidence: finalEvidenceWithRelations,
    quarantine: quarantinedEvidence,
    duplicateRemoved: duplicateRemovedDetails,
    duplicateMerged: duplicateMergedDetails,
    stats: {
      // ==========================================
      // EXTRACTION FUNNEL
      // ==========================================
      parsedEvidenceCount,
      structurallyInvalidCount,
      validatorAcceptedCount,
      quarantineCount: quarantinedEvidence.length,

      // ==========================================
      // DUPLICATE FUNNEL
      // ==========================================
      duplicateRemovedCount,
      duplicateMergedCount: mergedCount,
      finalCount: finalEvidenceWithRelations.length,

      // ==========================================
      // MULTI-OCCURRENCE TELEMETRY
      // ==========================================
      eligibleMultiCount,
      resolvedMultiCount,
      quarantineMultiCount,

      multiResolutionRate:
        eligibleMultiCount > 0
          ? resolvedMultiCount / eligibleMultiCount
          : null,

            multiQuarantineRate:
        eligibleMultiCount > 0
          ? quarantineMultiCount / eligibleMultiCount
          : null,

      // ==========================================
      // RELATION TELEMETRY (rule 19)
      // ==========================================
      relationFlaggedCount: relationFlagged,
      relationExpectedPairs: relationResult.expectedPairs,
      relationLinkedPairs: relationResult.linkedPairs,
      relationLinkRate:
        relationResult.expectedPairs > 0
          ? relationResult.linkedPairs / relationResult.expectedPairs
          : null,

      // ==========================================
      // PRODUCTION PROMPT
      // ==========================================
      promptVersion: 'A' as const
    },
    runInfo
  };
}

// ==========================================
// 4. API ROUTES (FITUR CLEANING & KAMUS)
// ==========================================
app.get('/api/templates', (_req: Request, res: Response) => {
  const templateList = PROMPT_TEMPLATES.map(({ id, name }) => ({ id, name }));
  res.json(templateList);
});

app.post('/api/correct-text', async (req: Request, res: Response) => {
  try {
    const { text, mode, templateId, customInstruction } = req.body as {
      text?: string;
      mode?: string;
      templateId?: string;
      customInstruction?: string;
    };
    if (!text) return res.status(400).json({ error: 'Teks kosong' });

    // 1. Resolve instruction
    let promptInstruction = '';
    if ((mode === 'custom' || mode === 'manual') && customInstruction) {
      promptInstruction = customInstruction;
    } else if (templateId) {
      const tpl = PROMPT_TEMPLATES.find(t => t.id === templateId);
      promptInstruction = tpl?.instruction ?? '';
    }
    if (!promptInstruction) {
      return res.status(400).json({ error: 'Instruksi tidak ditemukan' });
    }

    // 2. Deteksi tipe input
    const segments = parseSRT(text);
    const isSRT = segments.length > 0;
    const isSRTTemplate = typeof templateId === 'string' && templateId.startsWith('srt_');

    // 3. Mismatch: template SRT tapi input bukan SRT
    if (isSRTTemplate && !isSRT) {
      return res.status(400).json({
        error: 'Template SRT dipilih, tetapi input bukan format SRT. Pastikan input memiliki nomor segmen dan timestamp (00:00:00,000 --> 00:00:00,000).'
      });
    }

    // 4. Jalur SRT: strip timestamp, kirim teks saja
    if (isSRT) {
      const textOnly = segments
        .map(s => `[${s.index}] ${s.text.replace(/\n/g, ' ')}`)
        .join('\n');

      const systemInstruction = `Anda editor subtitle. Setiap baris dimulai dengan penanda [angka].
Perbaiki HANYA teks setelah penanda. JANGAN ubah penanda [angka].
JANGAN gabung, pecah, hapus, atau tambah baris.
JANGAN tambahkan penjelasan, komentar, atau teks non-dialog.
Output hanya baris dengan format: [angka] teks`;

      const result = await callLLMAPI(textOnly, promptInstruction, systemInstruction, getActiveProvider());
      if (!result.success) throw new Error(result.error);

      // Parse balik
      const fixedMap = new Map<number, string>();
      for (const line of result.content.split('\n')) {
        const m = line.match(/^\s*\[(\d+)\]\s*(.*)$/);
        if (m) fixedMap.set(parseInt(m[1], 10), m[2].trim());
      }

      // Validasi: semua indeks asli harus ada, tidak ada yang hilang
      const issues: string[] = [];
      for (const s of segments) {
        if (!fixedMap.has(s.index)) issues.push(`Segmen ${s.index} hilang dari output LLM`);
      }
      const extraIndices = [...fixedMap.keys()].filter(k => !segments.some(s => s.index === k));
      if (extraIndices.length > 0) issues.push(`Indeks tidak dikenal: ${extraIndices.join(', ')}`);

      if (issues.length > 0) {
        return res.json({
          success: false,
          error: `Validasi SRT gagal:\n- ${issues.join('\n- ')}`,
          correctedText: text,
          issues,
          mode
        });
      }

      // ▼ LANGKAH BARU 1: bangun ulang dulu, lalu apply post-normalize
      const rebuiltSegments: SRTSegment[] = segments.map(s => {
        const rawFixed = fixedMap.get(s.index) ?? s.text;
        return {
          index: s.index,
          start: s.start,
          end: s.end,
          text: applyPostNormalize(rawFixed)
        };
      });

      // ▼ LANGKAH BARU 2: deteksi duplikasi antar-segmen
      const dupIssues = detectCrossSegmentDuplication(rebuiltSegments);
      if (dupIssues.length > 0) {
        return res.json({
          success: false,
          error: `Duplikasi antar segmen terdeteksi:\n- ${dupIssues.join('\n- ')}`,
          correctedText: text,
          issues: dupIssues,
          mode
        });
      }

      const rebuilt = rebuiltSegments
        .map(s => `${s.index}\n${s.start} --> ${s.end}\n${s.text}\n`)
        .join('\n');

      return res.json({ success: true, correctedText: rebuilt, mode });
    }

    // 5. Jalur teks biasa
    const systemInstruction = `Anda editor teks. Perbaiki teks sesuai instruksi user. Output hanya teks hasil perbaikan, tanpa penjelasan tambahan.`;
    const result = await callLLMAPI(text, promptInstruction, systemInstruction, getActiveProvider());
    if (!result.success) throw new Error(result.error);

    return res.json({ success: true, correctedText: result.content, mode });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

app.get('/api/dictionary/:name', (_req: Request, res: Response) => {
  return res.json({});
});

// --------------------------------------------------
// VALIDASI EVIDENCE DASAR
// --------------------------------------------------

export function isValidEvidence(ev: unknown): boolean {
  if (
    !ev ||
    typeof ev !== 'object' ||
    Array.isArray(ev)
  ) {
    return false;
  }

  const anyEv = ev as { claim?: unknown };
  return (
    typeof anyEv.claim === 'string' &&
    anyEv.claim.trim().length > 0
  );
}

function countOccurrences(needle: string, haystack: string): number {
  if (!needle || !haystack) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

// --------------------------------------------------
// EVIDENCE ID
// --------------------------------------------------

export function assignEvidenceIds(
  evidence: EvidenceItem[],
  reviewId?: string | null
): EvidenceItem[] {
  const safeReviewId =
    reviewId && /^[\w-]{3,}$/.test(reviewId) ? reviewId : null;

  return evidence.map((ev, index) => {
    // Gunakan evidence_id yang sudah diberikan oleh globalEvidenceCounter
    const id = ev.evidence_id || `E${String(index + 1).padStart(3, '0')}`;
    return {
      ...ev,
      evidence_id: safeReviewId ? `${safeReviewId}-${id}` : id
    };
  });
}

// --------------------------------------------------
// TIMESTAMP DARI SOURCE COORDINATES
// --------------------------------------------------

function getTimestampFromCoordinates(
  coordinates: NonNullable<EvidenceItem['source_coordinates']>,
  segments: SRTSegment[]
): {
  timestamp_start: string | null;
  timestamp_end: string | null;
} {
  const startSegment = segments.find(
    segment => segment.index === coordinates.segment_start_index
  );

  const endSegment = segments.find(
    segment => segment.index === coordinates.segment_end_index
  );

  if (!startSegment || !endSegment) {
    return {
      timestamp_start: null,
      timestamp_end: null
    };
  }

  return {
    timestamp_start: startSegment.start,
    timestamp_end: endSegment.end
  };
}

// --------------------------------------------------
// RESOLUSI DUPLICATE GATE
// --------------------------------------------------

export interface DuplicateResolutionOutput {
  preservedEvidence: EvidenceItem[];
  duplicateRemovedDetails: Array<{
    evidence_id: string;
    reason: string;
    kept_evidence_id: string;
    claim?: string;           // <-- TAMBAHKAN INI
    source_excerpt?: string;  // <-- TAMBAHKAN INI
  }>;
  duplicateMergedDetails: Array<{
    evidence_id_a: string;
    evidence_id_b: string;
    merged_evidence_id: string;
    reason: string;
    /** NEW: semua evidence_id yang digabung (untuk chain-merge > 2). */
    merged_from_ids?: string[];
  }>;
}

// BARU: menerima `segments` (seluruh SRT, bukan hanya satu chunk) agar
// merged evidence bisa dibangun ulang EvidenceContext-nya dan divalidasi
// ulang lewat EvidenceValidator sebelum dianggap diterima. Tanpa ini,
// merged evidence mewarisi `validation` mentah dari evidenceA (klaim
// TUNGGAL, sudah PASS individual) padahal claim yang dipakai sekarang
// adalah gabungan dua klaim -- persis bentuk yang seharusnya kena
// ATOMICITY SUSPECT. Dikonfirmasi lewat data produksi: 45hfkSE5DvA-E153
// dan 45hfkSE5DvA-E167 lolos sebagai finalStatus VALID dengan seluruh
// hasil PASS meskipun claim-nya sudah berupa dua kalimat digabung.
export function resolveDuplicateActions(
  identifiedEvidence: EvidenceItem[],
  duplicateResult: DuplicateResult,
  segments: SRTSegment[]
): DuplicateResolutionOutput {
  const removedEvidenceIds = new Set<string>();
  const duplicateRemovedDetails: DuplicateResolutionOutput['duplicateRemovedDetails'] = [];

  const mergedEvidenceToAdd: EvidenceItem[] = [];
  const duplicateMergedDetails: DuplicateResolutionOutput['duplicateMergedDetails'] = [];

  // ▼ TAMBAHAN LOG
  console.log(`🔍 Duplicate pairs total: ${duplicateResult.duplicatePairs.length}`);
  for (const r of duplicateResult.duplicatePairs) {
    console.log(
      `   ${r.evidence_id_a} ↔ ${r.evidence_id_b} | action=${r.action} | ` +
      `hasMergedEvidence=${!!r.mergedEvidence} | keptId=${r.keptId ?? '-'} | reason="${r.reason}"`
    );
  }
  console.log('---');

  for (const resolution of duplicateResult.duplicatePairs) {
    if (resolution.action === 'PRESERVE') continue;

    if (resolution.action === 'MERGE') {
      if (!resolution.mergedEvidence) {
        console.warn(
          `⚠️ Resolution MERGE tanpa mergedEvidence untuk ` +
          `${resolution.evidence_id_a}/${resolution.evidence_id_b}, dilewati (PRESERVE fallback).`
        );
        continue;
      }

      // ▼ TAMBAHAN LOG
      console.log(
        `🔀 MERGE attempt: ${resolution.evidence_id_a}/${resolution.evidence_id_b}`
      );

      // Re-validasi merged evidence. resolveIdenticalOccurrenceOrMerge
      // menjamin source_coordinates evidenceA === evidenceB, jadi span
      // segmen yang sama bisa dipakai untuk membangun EvidenceContext.
      const mergedCoords = resolution.mergedEvidence.source_coordinates;
      let mergedForAcceptance = resolution.mergedEvidence;

      if (mergedCoords) {
        const mergedContext: EvidenceContext = {
          chunkIndex: mergedCoords.chunk_index,
          chunkText: segments
            .filter(
              s =>
                s.index >= mergedCoords.segment_start_index &&
                s.index <= mergedCoords.segment_end_index
            )
            .map(s => s.text)
            .join(' '),
          chunkSegments: segments.filter(
            s =>
              s.index >= mergedCoords.segment_start_index &&
              s.index <= mergedCoords.segment_end_index
          ),
          allSegments: segments
        };

        const mergedReport = EvidenceValidator.validate(
          resolution.mergedEvidence,
          mergedContext
        );

        if (!mergedReport.accepted) {
          // ▼ TINGKATKAN LOG INI
          console.warn(
            `⚠️ Merged evidence ${resolution.evidence_id_a}/${resolution.evidence_id_b} ` +
            `GAGAL re-validasi setelah digabung (${mergedReport.quarantineReason}). ` +
            `Batal MERGE, kedua evidence asal di-PRESERVE.`
          );
          console.warn(
            `   Detail: ` +
            JSON.stringify(
              mergedReport.results.map(r => ({
                rule: r.rule,
                status: r.status,
                severity: r.severity,
                reason: r.reason
              })),
              null,
              2
            )
          );
          console.warn(
            `   Merged claim: "${resolution.mergedEvidence.claim}"`
          );
          console.warn(
            `   Merged subtopic: ${resolution.mergedEvidence.subtopic} | ` +
            `merged_subtopics: ${JSON.stringify(resolution.mergedEvidence.merged_subtopics)}`
          );
          continue;
        }

        mergedForAcceptance = { ...resolution.mergedEvidence, validation: mergedReport };
      } else {
        console.warn(
          `⚠️ Merged evidence ${resolution.evidence_id_a}/${resolution.evidence_id_b} ` +
          `tidak punya source_coordinates, tidak bisa re-validasi. ` +
          `BATAL MERGE (Fail Closed) untuk mencegah data kotor lolos.`
        );
        continue; // <-- Jangan masukkan ke mergedEvidenceToAdd!
      }

      // Gunakan merged_from_evidence_ids untuk menghapus SEMUA member
      // chain. Fallback ke [evidence_id_a, evidence_id_b] untuk pairwise
      // (backward compat kalau merged_from_evidence_ids null).
      const idsToRemove =
        mergedForAcceptance.merged_from_evidence_ids ??
        [resolution.evidence_id_a, resolution.evidence_id_b].filter(Boolean);

      for (const id of idsToRemove) {
        if (id) removedEvidenceIds.add(id);
      }

      mergedEvidenceToAdd.push(mergedForAcceptance);

      duplicateMergedDetails.push({
        evidence_id_a: resolution.evidence_id_a,
        evidence_id_b: resolution.evidence_id_b,
        merged_evidence_id:
          mergedForAcceptance.evidence_id || resolution.evidence_id_a,
        reason: resolution.reason,
        merged_from_ids: mergedForAcceptance.merged_from_evidence_ids ?? undefined
      });

      continue;
    }

    let evidenceIdToRemove: string | null = null;
    let keptId: string | null = null;

    // Pakai field terstruktur keptId (lihat duplicate.ts), bukan lagi
    // menebak dari isi `reason`. Kalau suatu saat duplicate.ts lupa
    // mengisi keptId untuk KEEP_BEST/KEEP_FIRST, ini akan error keras
    // alih-alih diam-diam salah pilih A.
    if (resolution.action === 'KEEP_BEST' || resolution.action === 'KEEP_FIRST') {
      if (
        !resolution.keptId ||
        (
          resolution.keptId !== resolution.evidence_id_a &&
          resolution.keptId !== resolution.evidence_id_b
        )
      ) {
        console.warn(
          `⚠️ Resolution ${resolution.action} dengan keptId tidak valid untuk ` +
          `${resolution.evidence_id_a}/${resolution.evidence_id_b}: ` +
          `${resolution.keptId ?? '-'}, dilewati (PRESERVE fallback).`
        );
        continue;
      }
      keptId = resolution.keptId;
      evidenceIdToRemove =
        keptId === resolution.evidence_id_a
          ? resolution.evidence_id_b
          : resolution.evidence_id_a;
    }

    if (evidenceIdToRemove) {
      // Fix #5b: dedup. Satu evidence bisa muncul sebagai evidenceIdToRemove
      // di beberapa pair sekaligus (mis. E019 di-remove dari E019↔E021,
      // lalu lagi dari E019↔E022, lalu lagi dari E019↔E023). Tanpa guard
      // ini, ia di-push berkali-kali ke duplicateRemovedDetails, sehingga
      // duplicate_removed_count di stats menggelembung di atas jumlah
      // pengurangan final_evidence yang sebenarnya (terlihat di log:
      // duplicate_removed=15 padahal final_evidence hanya turun 11).
      if (!removedEvidenceIds.has(evidenceIdToRemove)) {
        removedEvidenceIds.add(evidenceIdToRemove);
        
        // Ambil data asli dari evidence yang dihapus
        const removedEv = identifiedEvidence.find(e => e.evidence_id === evidenceIdToRemove);
        
        duplicateRemovedDetails.push({
          evidence_id: evidenceIdToRemove,
          reason: resolution.reason,
          kept_evidence_id: keptId || '',
          claim: removedEv?.claim || '',
          source_excerpt: removedEv?.source_excerpt || ''
        });
      }
    } else {
      // Action KEEP_FIRST/KEEP_BEST yang tidak menghasilkan aksi
      console.log(
        `ℹ️ Skip: ${resolution.evidence_id_a}/${resolution.evidence_id_b} | ` +
        `action=${resolution.action} | evidenceIdToRemove=null`
      );
    }
  }

  const preservedEvidence = identifiedEvidence
    .filter(ev => !removedEvidenceIds.has(ev.evidence_id || ''))
    .concat(mergedEvidenceToAdd);

  return { preservedEvidence, duplicateRemovedDetails, duplicateMergedDetails };
}

// --------------------------------------------------
// ANALYZE REVIEW (Endpoint utama)
// --------------------------------------------------

app.post('/api/analyze-review', async (req: Request, res: Response) => {
  try {
    const { metadata = {}, srtContent, reviewerName = 'Reviewer' } = req.body as {
      metadata?: ReviewMetadata;
      srtContent?: string;
      reviewerName?: string;
    };

    if (!srtContent || typeof srtContent !== 'string') {
      return res.status(400).json({
        error: 'Konten transcript.srt kosong atau tidak valid.'
      });
    }

    const [summary, evidenceResult] = await Promise.all([
      generateSummary(srtContent, metadata, reviewerName),
      extractEvidence(srtContent, metadata, reviewerName)
    ]);

    logRunLine('analyze-review', evidenceResult.stats, evidenceResult.runInfo);

    return res.json({
      success: true,
      run_id: evidenceResult.runInfo.run_id,
      run_metadata: {
        chunk_chars: evidenceResult.runInfo.chunk_chars,
        chunk_overlap: evidenceResult.runInfo.chunk_overlap,
        git_commit: RUN_FINGERPRINT.git_commit,
        code_hash: RUN_FINGERPRINT.code_hash,
        rules_version: RULES_VERSION
      },
      metadata,
      summary,
      evidence: evidenceResult.evidence,
      quarantine: evidenceResult.quarantine,
      duplicateRemoved: evidenceResult.duplicateRemoved,
      duplicateMerged: evidenceResult.duplicateMerged,
      stats: evidenceResult.stats
    });

  } catch (error) {
    console.error('❌ Error in analyze-review:', error);
    return res.status(500).json({
      error: (error as Error)?.message || 'Terjadi kesalahan pada server.'
    });
  }
});

// ==========================================
// ENDPOINT: GENERATE SUMMARY SAJA
// ==========================================
app.post('/api/summary', async (req: Request, res: Response) => {
  try {
    const { srtContent, metadata = {}, reviewerName = 'Reviewer' } = req.body as {
      srtContent?: string;
      metadata?: ReviewMetadata;
      reviewerName?: string;
    };
    if (!srtContent || typeof srtContent !== 'string') {
      return res.status(400).json({ error: 'srtContent wajib diisi dan berupa string.' });
    }

    const summary = await generateSummary(srtContent, metadata, reviewerName);
    res.json({ success: true, summary });
  } catch (error) {
    console.error('❌ Error di /api/summary:', error);
    res.status(500).json({ error: (error as Error).message || 'Terjadi kesalahan pada server.' });
  }
});

// ==========================================
// ENDPOINT: EXTRACT EVIDENCE SAJA
// ==========================================
app.post('/api/evidence', async (req: Request, res: Response) => {
  try {
    const { srtContent, metadata = {}, reviewerName = 'Reviewer' } = req.body as {
      srtContent?: string;
      metadata?: ReviewMetadata;
      reviewerName?: string;
    };
    if (!srtContent || typeof srtContent !== 'string') {
      return res.status(400).json({ error: 'srtContent wajib diisi dan berupa string.' });
    }

    const result = await extractEvidence(
      srtContent,
      metadata,
      reviewerName
    );

    logRunLine('evidence', result.stats, result.runInfo);

    res.json({ 
      success: true, 
      run_id: result.runInfo.run_id,
      run_metadata: {
        chunk_chars: result.runInfo.chunk_chars,
        chunk_overlap: result.runInfo.chunk_overlap,
        git_commit: RUN_FINGERPRINT.git_commit,
        code_hash: RUN_FINGERPRINT.code_hash,
        rules_version: RULES_VERSION
      },
      ...result 
    });
  } catch (error) {
    console.error('❌ Error di /api/evidence:', error);
    res.status(500).json({ error: (error as Error).message || 'Terjadi kesalahan pada server.' });
  }
});

// ==========================================
// 6. START SERVER
// ==========================================
async function startServer(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        // runs/ ditulis server saat ekstraksi (runs.jsonl, chunk-N.raw.txt, SRT).
        // Tanpa ini watcher Vite menganggapnya perubahan source dan me-reload
        // halaman, sehingga hasil di UI (dan tombol download) hilang.
        watch: {
          ignored: ['**/runs/**', `${RUN_LOG_DIR.replace(/\\/g, '/')}/**`]
        }
      },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) =>
      res.sendFile(path.join(distPath, 'index.html'))
    );
  }
  app.listen(PORT, '0.0.0.0', () =>
    console.log(`Server running on http://0.0.0.0:${PORT}`)
  );
}

if (!process.env.VITEST) {
  void startServer();
}
