// ============================================================
// RELATION VALIDATOR — GLOBAL PASS
// ============================================================
// Berjalan setelah semua evidence terkumpul, timestamp tervalidasi,
// dan duplicate gate selesai. Menegakkan rule 19 prompt v6:
// related_evidence_ids WAJIB diisi untuk pola-pola tertentu.
//
// Berbeda dari 5 validator per-evidence (GROUNDING, PROVENANCE,
// ASSESSMENT, VALUE, ATOMICITY), RELATION butuh akses ke SELURUH
// daftar evidence untuk mencari pasangan yang seharusnya bertaut.
// Pola arsitektur mengikuti DuplicateValidator.detect().
//
// Pola yang dideteksi di v1:
//   1. PRESET ↔ HASIL
//      Evidence dengan attribute="graphics_preset" harus menautkan
//      ke evidence dengan attribute frame_rate/fps untuk game yang
//      sama. Dan sebaliknya.
//      Akar kasus: E005 ("highest 60") vs E149/E154 (fps aktual).
//
//   2. KONDISI BERBEDA
//      Evidence dengan context "tanpa kipas" harus menautkan ke
//      evidence dengan context "dengan kipas" (dan sebaliknya)
//      untuk topic+subtopic yang sama. Akar kasus: E149 vs E154.
//
// CHANGELOG v2:
//   - Per-pair check menggantikan anyLinked group check.
//     Sebelumnya: kalau SATU pasangan bertaut, seluruh grup dianggap
//     OK -- menyebabkan under-detection (log: 13/23 pairs tidak
//     bertaut, tapi hanya 3 evidence di-flag). Sekarang SETIAP
//     pasangan yang tidak bertaut disumbangkan ke daftar partner
//     unlinked per-evidence, dan setiap evidence yang punya minimal
//     satu partner unlinked di-flag SEKALI dengan daftar partnernya.
//
// Pola yang SENGAJA TIDAK dideteksi di v1 (butuh NLP atau daftar
// domain-spesifik):
//   - KLAIM VENDOR ↔ PENGUKURAN (butuh matching semantik)
//   - DUA KOMPONEN SATU SERTIFIKASI (IP67 angka 6 ↔ 7)
//   - KAMERA BERBEDA, SKENARIO SAMA (selfie/ultrawide/utama)
//   - PEMBANDING (comparison_target)
//
// Severity: MEDIUM (non-blocking). Evidence tetap diterima, hanya
// ditandai via validation.finalStatus = VALID_WITH_NORMALIZATION.
// Konservatif karena ini validator baru; severity bisa dinaikkan
// setelah ada bukti produksi bahwa model konsisten mengisi refs.
// ============================================================

import type { EvidenceItem, ValidationResult } from '../types';
import { normalizeForSearch } from '../srt';

// ------------------------------------------------------------
// TIPE
// ------------------------------------------------------------

export type RelationRule =
  | 'preset_without_result'
  | 'result_without_preset'
  | 'condition_pair_missing';

export interface RelationViolation {
  evidence_id: string;
  rule: RelationRule;
  expected_pattern: string;
  reason: string;
}

export interface RelationResult {
  violations: RelationViolation[];
  /** Map evidence_id -> violation yang menimpanya. */
  violationsByEvidence: Map<string, RelationViolation[]>;
  /** Telemetry: total pasangan yang seharusnya bertaut. */
  expectedPairs: number;
  /** Telemetry: pasangan yang benar-benar bertaut (minimal satu arah). */
  linkedPairs: number;
}

// ------------------------------------------------------------
// HELPER
// ------------------------------------------------------------

function nz(v: unknown): string {
  return normalizeForSearch(String(v ?? ''));
}

/**
 * True jika attribute atau attribute_value mengandung salah satu
 * needle (setelah normalisasi).
 */
function hasAttr(ev: EvidenceItem, ...needles: string[]): boolean {
  const attr = nz(ev.attribute);
  const attrVal = nz(ev.attribute_value);
  return needles.some(n => attr.includes(n) || attrVal.includes(n));
}

/**
 * Kunci identitas game. Prefer subtopic (paling spesifik);
 * fallback ke topic bila topic adalah gaming/benchmark.
 */
function getGameKey(ev: EvidenceItem): string | null {
  const st = nz(ev.subtopic);
  if (st) return st;
  const topic = nz(ev.topic);
  if (topic === 'gaming' || topic === 'benchmark') return topic;
  return null;
}

function hasRefsTo(ev: EvidenceItem, targetId: string): boolean {
  const refs = ev.related_evidence_ids;
  if (!refs || refs.length === 0) return false;
  return refs.includes(targetId);
}

/** True jika A menautkan B, atau B menautkan A. */
function anyRefBetween(a: EvidenceItem, b: EvidenceItem): boolean {
  const idA = a.evidence_id ?? '';
  const idB = b.evidence_id ?? '';
  if (!idA || !idB) return false;
  return hasRefsTo(a, idB) || hasRefsTo(b, idA);
}

/**
 * Helper untuk melacak partner yang tidak bertaut per evidence.
 * Return { map, add } agar bisa dipakai di kedua pola.
 */
function makeUnlinkedTracker() {
  const map = new Map<string, Set<string>>();
  const add = (fromId: string, partnerId: string) => {
    if (!fromId) return;
    // Defensive: jangan catat self sebagai partner.
    if (fromId === partnerId) return;
    let set = map.get(fromId);
    if (!set) {
      set = new Set();
      map.set(fromId, set);
    }
    if (partnerId) set.add(partnerId);
  };
  return { map, add };
}

/**
 * Format daftar partner untuk pesan violation (maks 3 + "dan N lainnya").
 */
function formatPartnerList(partners: Set<string>): string {
  const arr = [...partners];
  const shown = arr.slice(0, 3).join(', ');
  const more = arr.length > 3 ? ` (+${arr.length - 3} lainnya)` : '';
  return `${arr.length} partner (${shown}${more})`;
}

// ------------------------------------------------------------
// KONDISI BERBEDA — pola yang dikenali
// ------------------------------------------------------------
// Hanya "tanpa kipas" ↔ "dengan kipas" yang dipakai di v1.
// Pola lain (120Hz/60Hz untuk battery, dst.) bisa ditambah nanti.
const CONDITION_PAIRS: Array<{ a: RegExp; b: RegExp; label: string }> = [
  {
    a: /\btanpa\s+kipas\b/,
    b: /\bdengan\s+kipas\b/,
    label: 'tanpa kipas ↔ dengan kipas'
  }
];

// ------------------------------------------------------------
// DETECT
// ------------------------------------------------------------

export const RelationValidator = {
  detect(evidenceList: EvidenceItem[]): RelationResult {
    const violations: RelationViolation[] = [];
    const violationsByEvidence = new Map<string, RelationViolation[]>();
    let expectedPairs = 0;
    let linkedPairs = 0;

    const addViolation = (v: RelationViolation) => {
      violations.push(v);
      let arr = violationsByEvidence.get(v.evidence_id);
      if (!arr) {
        arr = [];
        violationsByEvidence.set(v.evidence_id, arr);
      }
      arr.push(v);
    };

    // ── Pola 1: PRESET ↔ HASIL ─────────────────────────────
    const gamingByKey = new Map<string, EvidenceItem[]>();

    for (const ev of evidenceList) {
      const topic = nz(ev.topic);
      if (topic !== 'gaming' && topic !== 'benchmark') continue;
      const key = getGameKey(ev);
      if (!key) continue;
      let arr = gamingByKey.get(key);
      if (!arr) {
        arr = [];
        gamingByKey.set(key, arr);
      }
      arr.push(ev);
    }

    for (const [gameKey, evs] of gamingByKey.entries()) {
      const presets = evs.filter(ev =>
        hasAttr(ev, 'preset', 'graphics preset')
      );
      const results = evs.filter(ev =>
        hasAttr(ev, 'frame rate', 'fps', 'framerate')
      );

      // ── Kasus 1a: preset ada, result tidak ada ─────────────
      // Tidak ada pasangan untuk dibanding, tapi rule 19 tetap
      // melanggar karena preset seharusnya punya pasangan hasil.
      if (presets.length > 0 && results.length === 0) {
        for (const p of presets) {
          if (!p.evidence_id) continue;
          addViolation({
            evidence_id: p.evidence_id,
            rule: 'preset_without_result',
            expected_pattern: 'graphics_preset ↔ frame_rate',
            reason:
              `Evidence preset grafis untuk "${gameKey}" tidak memiliki ` +
              `evidence frame rate pasangan di daftar. Rule 19 mewajibkan ` +
              `preset menautkan ke hasil pengukuran.`
          });
        }
      }

      // ── Kasus 1b: result ada, preset tidak ada ─────────────
      if (results.length > 0 && presets.length === 0) {
        for (const r of results) {
          if (!r.evidence_id) continue;
          addViolation({
            evidence_id: r.evidence_id,
            rule: 'result_without_preset',
            expected_pattern: 'frame_rate ↔ graphics_preset',
            reason:
              `Evidence frame rate untuk "${gameKey}" tidak memiliki ` +
              `evidence preset grafis pasangan di daftar. Rule 19 mewajibkan ` +
              `hasil menautkan ke preset pengujiannya.`
          });
        }
      }

      // ── Kasus 1c: preset DAN result ada — per-pair check ───
      if (presets.length > 0 && results.length > 0) {
        const { map: unlinkedPartners, add: addUnlinked } =
          makeUnlinkedTracker();

        for (const p of presets) {
          for (const r of results) {
            // Skip kalau evidence yang sama masuk ke dua filter (attribute
            // memuat 'preset' DAN 'fps'). Self-pair tidak punya makna.
            if (p.evidence_id && p.evidence_id === r.evidence_id) continue;

            expectedPairs++;
            if (anyRefBetween(p, r)) {
              linkedPairs++;
            } else {
              addUnlinked(p.evidence_id ?? '', r.evidence_id ?? '');
              addUnlinked(r.evidence_id ?? '', p.evidence_id ?? '');
            }
          }
        }

        for (const [evId, partners] of unlinkedPartners) {
          const isPreset = presets.some(p => p.evidence_id === evId);
          addViolation({
            evidence_id: evId,
            rule: isPreset ? 'preset_without_result' : 'result_without_preset',
            expected_pattern: 'graphics_preset ↔ frame_rate',
            reason:
              `Evidence "${gameKey}" tidak bertaut dengan ` +
              `${formatPartnerList(partners)}. Rule 19 mewajibkan ` +
              `preset dan hasil pengukuran saling menautkan.`
          });
        }
      }
    }

    // ── Pola 2: KONDISI BERBEDA (tanpa kipas ↔ dengan kipas) ─
    type CondGroup = {
      withCondition: EvidenceItem[];
      withoutCondition: EvidenceItem[];
    };
    const conditionGroups = new Map<string, CondGroup>();

    for (const ev of evidenceList) {
      const ctx = nz(ev.context);
      if (!ctx) continue;
      const topic = nz(ev.topic);
      const subtopic = nz(ev.subtopic);
      const key = `${topic}|${subtopic}`;
      if (key === '|') continue;

      let grp = conditionGroups.get(key);
      if (!grp) {
        grp = { withCondition: [], withoutCondition: [] };
        conditionGroups.set(key, grp);
      }
      for (const pair of CONDITION_PAIRS) {
        if (pair.a.test(ctx)) grp.withoutCondition.push(ev);
        if (pair.b.test(ctx)) grp.withCondition.push(ev);
      }
    }

    for (const [key, grp] of conditionGroups.entries()) {
      if (
        grp.withoutCondition.length === 0 ||
        grp.withCondition.length === 0
      ) {
        continue;
      }

      const { map: unlinkedPartners, add: addUnlinked } =
        makeUnlinkedTracker();

      for (const w of grp.withoutCondition) {
        for (const c of grp.withCondition) {
          if (w.evidence_id && w.evidence_id === c.evidence_id) continue;

          expectedPairs++;
          if (anyRefBetween(w, c)) {
            linkedPairs++;
          } else {
            addUnlinked(w.evidence_id ?? '', c.evidence_id ?? '');
            addUnlinked(c.evidence_id ?? '', w.evidence_id ?? '');
          }
        }
      }

      const pairLabel = CONDITION_PAIRS.map(p => p.label).join(', ');
      for (const [evId, partners] of unlinkedPartners) {
        addViolation({
          evidence_id: evId,
          rule: 'condition_pair_missing',
          expected_pattern: pairLabel,
          reason:
            `Evidence dengan kondisi berbeda untuk "${key}" tidak ` +
            `bertaut dengan ${formatPartnerList(partners)}. Rule 19 ` +
            `mewajibkan evidence dari kondisi berbeda saling menautkan.`
        });
      }
    }

    return {
      violations,
      violationsByEvidence,
      expectedPairs,
      linkedPairs
    };
  }
};

// ------------------------------------------------------------
// APPLY — push ValidationResult ke evidence yang melanggar
// ------------------------------------------------------------
// Tidak mengubah evidence_id, source_coordinates, atau field inti
// lainnya. Hanya:
//   - menambahkan satu ValidationResult (rule=RELATION, MEDIUM)
//   - mengubah finalStatus VALID -> VALID_WITH_NORMALIZATION
// Evidence yang tidak melanggar tidak disentuh (referensi objek
// sama, tidak ada shallow copy).
// ------------------------------------------------------------

export function applyRelationViolations(
  evidenceList: EvidenceItem[],
  result: RelationResult
): { evidenceList: EvidenceItem[]; flagged: number } {
  let flagged = 0;

  const out = evidenceList.map(ev => {
    const id = ev.evidence_id ?? '';
    const vios = result.violationsByEvidence.get(id);
    if (!vios || vios.length === 0) return ev;

    const existingValidation = ev.validation;
    if (!existingValidation) {
      // Defensive: evidence tanpa validation report tidak bisa ditandai.
      // Seharusnya tidak terjadi karena server.ts selalu mengisi
      // validation sebelum final.
      return ev;
    }

    flagged++;

    const reason = vios
      .map(v => `[${v.rule}] ${v.reason}`)
      .join(' | ');

    const relationResult: ValidationResult = {
      pass: true, // SUSPECT MEDIUM = non-blocking
      status: 'SUSPECT',
      rule: 'RELATION',
      reason,
      severity: 'MEDIUM'
    };

    const nextFinalStatus =
      existingValidation.finalStatus === 'VALID'
        ? ('VALID_WITH_NORMALIZATION' as const)
        : existingValidation.finalStatus;

    return {
      ...ev,
      validation: {
        ...existingValidation,
        results: [...existingValidation.results, relationResult],
        finalStatus: nextFinalStatus
      }
    };
  });

  return { evidenceList: out, flagged };
}