// ============================================================
// RELATION AUTO-FILL — POST-PROCESS
// ============================================================
// Setelah semua chunk diproses dan evidence final terkumpul,
// lengkapi related_evidence_ids untuk pola yang bersifat
// LINTAS-CHUNK (preset↔fps, kondisi beda).
//
// Alasan: model di chunk 0 tidak tahu akan ada fps di chunk 6.
// Tidak realistis meminta model menautkan lintas chunk saat
// ekstraksi. Auto-fill di post-process menyelesaikan masalah ini
// secara deterministik.
//
// Pola yang di-auto-fill di sini:
//   1. PRESET ↔ FPS untuk game yang sama (subtopic + topic=gaming).
//   2. KONDISI BERBEDA untuk metrik yang sama (context mirror).
//
// Auto-fill HANYA MENAMBAH ref yang belum ada. Tidak menghapus
// ref yang sudah diisi model.
// ============================================================

import type { EvidenceItem } from '../types';
import { normalizeForSearch } from '../srt';

function nz(v: unknown): string {
  return normalizeForSearch(String(v ?? ''));
}

function hasAttr(ev: EvidenceItem, ...needles: string[]): boolean {
  const attr = nz(ev.attribute);
  const av = nz(ev.attribute_value);
  return needles.some(n => attr.includes(n) || av.includes(n));
}

function getGameKey(ev: EvidenceItem): string | null {
  const st = nz(ev.subtopic);
  if (st) return st;
  const topic = nz(ev.topic);
  if (topic === 'gaming' || topic === 'benchmark') return topic;
  return null;
}

function addRefOnce(ev: EvidenceItem, targetId: string): boolean {
  if (!targetId || targetId === ev.evidence_id) return false;
  const refs = ev.related_evidence_ids ?? [];
  if (refs.includes(targetId)) return false;
  ev.related_evidence_ids = [...refs, targetId];
  return true;
}

export interface AutoFillStats {
  presetLinksAdded: number;
  conditionLinksAdded: number;
  evidenceTouched: number;
}

export function autoFillRelatedIds(
  evidenceList: EvidenceItem[]
): AutoFillStats {
  let presetLinksAdded = 0;
  let conditionLinksAdded = 0;
  const touched = new Set<string>();

  // ── Pola 1: PRESET ↔ FPS (per game) ──────────────────────
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

  for (const evs of gamingByKey.values()) {
    const presets = evs.filter(ev =>
      hasAttr(ev, 'preset', 'graphics preset')
    );
    const results = evs.filter(ev =>
      hasAttr(ev, 'frame rate', 'fps', 'framerate')
    );

    for (const p of presets) {
      for (const r of results) {
        if (!p.evidence_id || !r.evidence_id) continue;
        if (addRefOnce(p, r.evidence_id)) {
          presetLinksAdded++;
          touched.add(p.evidence_id);
        }
        if (addRefOnce(r, p.evidence_id)) {
          presetLinksAdded++;
          touched.add(r.evidence_id);
        }
      }
    }
  }

  // ── Pola 2: KONDISI BERBEDA (tanpa kipas ↔ dengan kipas) ─
  const CONDITION_PAIRS: Array<{ a: RegExp; b: RegExp }> = [
    { a: /\btanpa\s+kipas\b/, b: /\bdengan\s+kipas\b/ }
  ];

  const condGroups = new Map<string, { w: EvidenceItem[]; c: EvidenceItem[] }>();
  for (const ev of evidenceList) {
    const ctx = nz(ev.context);
    if (!ctx) continue;
    const key = `${nz(ev.topic)}|${nz(ev.subtopic)}`;
    if (key === '|') continue;
    let g = condGroups.get(key);
    if (!g) {
      g = { w: [], c: [] };
      condGroups.set(key, g);
    }
    for (const p of CONDITION_PAIRS) {
      if (p.a.test(ctx)) g.w.push(ev);
      if (p.b.test(ctx)) g.c.push(ev);
    }
  }

  for (const g of condGroups.values()) {
    for (const w of g.w) {
      for (const c of g.c) {
        if (!w.evidence_id || !c.evidence_id) continue;
        if (addRefOnce(w, c.evidence_id)) {
          conditionLinksAdded++;
          touched.add(w.evidence_id);
        }
        if (addRefOnce(c, w.evidence_id)) {
          conditionLinksAdded++;
          touched.add(c.evidence_id);
        }
      }
    }
  }

  return {
    presetLinksAdded,
    conditionLinksAdded,
    evidenceTouched: touched.size
  };
}