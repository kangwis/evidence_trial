// src/evidence/related-ids.ts
//
// Memetakan related_evidence_ids yang ditulis LLM (nomor LOKAL per chunk,
// mis. "E031") ke evidence_id FINAL (mis. "Bmgp2VZufRY-E030").
//
// Latar belakang bug: LLM menomori item menurut urutan keluarannya sendiri,
// termasuk item yang kemudian dibuang (gagal struktural / karantina).
// assignEvidenceIds menomori ulang hanya item yang lolos, sehingga semua
// nomor setelah item terbuang bergeser.
//
// Alur pemakaian di pipeline:
//   1. Per chunk, panggil buildChunkLocalKeys(chunkEvidence) SEBELUM filter
//      struktural/validasi. Hasilnya satu LocalKey per item parse.
//   2. Saat item lolos validasi, push LocalKey-nya ke array paralel
//      `allEvidenceKeys` (indeks sama dengan allEvidence).
//   3. Setelah assignEvidenceIds: remapRelatedIds(identified, keys).
//   4. Setelah duplicate gate: redirectRelatedIds(preserved, removed, merged).
//
// CHANGELOG:
//   - RemapStats: tambah `evidenceWithRawRefs` dan `evidenceWithMappedRefs`
//     (Set<evidence_id>). Observability untuk validator RELATION yang akan
//     datang: bisa membedakan evidence yang LLM tidak beri ref sama sekali
//     (kemungkinan violation rule 19) dari evidence yang LLM beri ref tapi
//     semua terbuang saat remap (kemungkinan data loss / lintas chunk).
//     TIDAK mengubah perilaku remap; murni tracking tambahan.
//     CATATAN: kedua field bertipe Set, sehingga TIDAK muncul di
//     JSON.stringify(stats). Konsumen yang butuh serialisasi harus
//     mengonversi ke array sendiri.

export interface LocalKey {
  chunkIndex: number;
  /** Nomor lokal ternormalisasi, mis. "E031" (atau null jika tak ada). */
  localId: string | null;
  /** Posisi 1-based di array hasil parse chunk (sebelum filter apa pun). */
  position: number;
  /** Cara nomor lokal ditentukan; ikut di key agar label mode tidak bergantung pada diagnostik terpisah. */
  mode: 'llm-ids' | 'position';
}

/** Diagnostik per chunk: kenapa mode dipilih dan nomor lokal apa saja yang ada. */
export interface ChunkKeyDiagnostics {
  chunkIndex: number;
  mode: 'llm-ids' | 'position';
  /** Alasan mode: 'ok' bila evidence_id LLM lengkap dan unik. */
  reason: 'ok' | 'missing-ids' | 'duplicate-ids' | 'empty-chunk' | 'auto-fill-collision';
  /** Rentang nomor lokal terkecil..terbesar (untuk melihat basis penomoran LLM). */
  idRange: [string, string] | null;
  totalParsed: number;
  missingIds: number;
  duplicateIds: string[];
  /** Semua nomor lokal (dari SEMUA item parse, termasuk yang dibuang). */
  allLocalIds: string[];
  /** BARU: jumlah item yang evidence_id-nya di-auto-fill parser */
  autoFilledCount: number;
  /** BARU: jumlah item dengan source='model' (tidak di-auto-fill) */
  modelProvidedCount: number;
  /** ID yang ambiguous (duplikat atau collision) — referensi ke ID ini akan di-drop */
  ambiguousIds: string[];
  /**
   * Posisi 1-based yang ID model-nya tidak sesuai urutan array.
   * Observability only — ID tetap dipakai untuk pemetaan.
   * Hanya berisi posisi dengan source='model' dan ID unik.
   */
  outOfOrderPositions: number[];
}

export interface DroppedRef {
  from: string;          // evidence_id final item sumber
  ref: string;           // nilai mentah dari LLM
  reason: 'target-removed' | 'target-nonexistent' | 'target-unclassified' | 'unparseable' | 'ambiguous';
}

export interface ChunkRemapStats {
  chunkIndex: number;
  mode: 'llm-ids' | 'position';
  reason: ChunkKeyDiagnostics['reason'] | 'unknown';
  itemsAccepted: number;
  emitted: number;
  mapped: number;
  droppedTargetRemoved: number;
  droppedTargetNonexistent: number;
  droppedTargetUnclassified: number;
  droppedUnparseable: number;
  droppedSelf: number;
  droppedDuplicate: number;
  /** BARU: referensi ke ID yang collision (auto-fill + model) — tidak bisa dipetakan dengan aman */
  droppedAmbiguous: number;
  samples: DroppedRef[];
}

interface HasRelated {
  evidence_id?: string | null;
  related_evidence_ids?: unknown;
}

export interface RemapStats {
  totalRefs: number;
  mapped: number;
  droppedUnknown: number; // menunjuk item terbuang / tak dikenal
  droppedSelf: number;
  droppedDuplicate: number;
  droppedAmbiguous: number;
  chunksUsingLlmIds: number;
  chunksUsingPosition: number;
  perChunk: ChunkRemapStats[];
  /**
   * Set evidence_id final yang LLM beri related_evidence_ids (raw.length > 0).
   * Set berisi ID, bukan index, sehingga aman dipakai lintas tahap.
   * Digunakan validator RELATION untuk membedakan "LLM tidak menulis refs"
   * (kemungkinan violation rule 19) dari "semua refs terbuang" (data loss).
   */
  evidenceWithRawRefs: Set<string>;
  /**
   * Set evidence_id final yang SETELAH remap masih punya minimal satu ref valid.
   * Selisih `evidenceWithRawRefs - evidenceWithMappedRefs` = evidence yang
   * LLM beri refs tapi semua terbuang (mis. referensi lintas chunk, atau
   * target di-quarantine).
   */
  evidenceWithMappedRefs: Set<string>;
}

const LOCAL_RE = /E(\d{1,6})\b/i;

/** "E31", "e031", "Bmgp2VZufRY-E031" -> "E031". Selain itu null. */
export function normalizeLocalId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(LOCAL_RE);
  if (!m) return null;
  return `E${m[1].padStart(3, '0')}`;
}

function posToLocal(position: number): string {
  return `E${String(position).padStart(3, '0')}`;
}

/**
 * Bangun LocalKey untuk satu chunk dari SEMUA item hasil parse
 * (sebelum isValidEvidence). Memakai evidence_id buatan LLM jika semuanya
 * ada dan unik; jika tidak, jatuh ke posisi 1-based.
 */
export function buildChunkLocalKeys(
  chunkEvidence: Array<{ evidence_id?: unknown }>,
  chunkIndex: number,
  idMetadata?: import('./production-pipeline').EvidenceIdMetadata[]
): { keys: LocalKey[]; mode: 'llm-ids' | 'position'; diagnostics: ChunkKeyDiagnostics } {
  const llmIds = chunkEvidence.map(e => normalizeLocalId(e?.evidence_id));
  const missingIds = llmIds.filter(id => id === null).length;
  const counts = new Map<string, number>();
  for (const id of llmIds) if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  const duplicateIds = [...counts.entries()].filter(([, c]) => c > 1).map(([id]) => id);

  // BARU: Deteksi collision antara ID auto-fill dan ID model.
  // Skenario: parser auto-fill E001 di posisi 1; model menulis E001 di posisi 2.
  // Keduanya normalizeLocalId → "E001", tapi berasal dari sumber berbeda.
  // Referensi model ke "E001" tidak bisa dipetakan dengan aman → ambiguous.
  let hasAutoFillCollision = false;
  let ambiguousIds: string[] = [];
  let autoFilledCount = 0;
  let modelProvidedCount = 0;
  if (idMetadata && idMetadata.length === chunkEvidence.length) {
    const bySource = new Map<string, Set<'model' | 'auto-fill'>>();
    for (let i = 0; i < idMetadata.length; i++) {
      const meta = idMetadata[i];

      // Item invalid (bukan objek) tidak punya ID dan tidak bisa
      // di-auto-fill. Skip eksplisit — bukan bagian dari
      // autoFilledCount maupun modelProvidedCount.
      if (meta.source === 'invalid') continue;

      // Setelah filter di atas, TS men-narrow `meta.source` menjadi
      // 'model' | 'auto-fill'. Logic di bawah aman dari kedua sisi
      // (tipe maupun runtime).
      const finalId =
        meta.source === 'auto-fill'
          ? posToLocal(meta.position)
          : (meta.originalId ? normalizeLocalId(meta.originalId) : null);
      if (!finalId) continue;

      if (!bySource.has(finalId)) bySource.set(finalId, new Set());
      bySource.get(finalId)!.add(meta.source);

      if (meta.source === 'auto-fill') autoFilledCount++;
      else modelProvidedCount++;
    }
    for (const [id, sources] of bySource.entries()) {
      if (sources.has('model') && sources.has('auto-fill')) {
        ambiguousIds.push(id);
        hasAutoFillCollision = true;
      }
    }
  }

  // Semua ID duplikat bersifat ambiguous, terlepas dari sumbernya:
  // - model + model (model menulis ID sama dua kali)
  // - model + auto-fill (collision)
  // - auto-fill + auto-fill (tidak mungkin karena posisi unik)
  //
  // Referensi ke ID duplikat tidak bisa dipetakan dengan aman karena
  // model mungkin maksudkan posisi yang berbeda dari yang di-resolve
  // oleh map. Ini selaras dengan keputusan C (preserve + diagnose).
  ambiguousIds = [...new Set([...ambiguousIds, ...duplicateIds])].sort();

    // Diagnosis ID model yang tidak sesuai urutan array.
  // Tidak mengubah mapping — hanya observability.
  // ID unik yang out-of-order tetap dipakai; hanya posisi yang dicatat.
  const outOfOrderPositions: number[] = [];

  const hasAlignedMetadata =
    idMetadata !== undefined &&
    idMetadata.length === chunkEvidence.length;

  for (let i = 0; i < chunkEvidence.length; i++) {
    // Jika metadata tersedia, hanya ID dari model yang diperiksa.
    // Jika metadata tidak diberikan (API lama), ID yang tersedia
    // dianggap berasal dari model.
    if (hasAlignedMetadata && idMetadata[i].source !== 'model') {
      continue;
    }

    const actualId = hasAlignedMetadata
      ? normalizeLocalId(idMetadata[i].originalId)
      : llmIds[i];

    const expectedId = posToLocal(i + 1);

    if (
      actualId &&
      actualId !== expectedId &&
      !duplicateIds.includes(actualId)
    ) {
      outOfOrderPositions.push(i + 1);
    }
  }

  let reason: ChunkKeyDiagnostics['reason'] = 'ok';

  if (llmIds.length === 0) {
    reason = 'empty-chunk';
  } else if (hasAutoFillCollision) {
    reason = 'auto-fill-collision';
  } else if (duplicateIds.length > 0) {
    reason = 'duplicate-ids';
  } else if (missingIds > 0) {
    reason = 'missing-ids';
  }
  const mode: 'llm-ids' | 'position' = reason === 'ok' ? 'llm-ids' : 'position';

  const keys: LocalKey[] = chunkEvidence.map((_, i) => ({
    chunkIndex,
    position: i + 1,
    mode,
    localId: mode === 'llm-ids' ? llmIds[i] : posToLocal(i + 1)
  }));
  const allLocalIds = keys.map(k => k.localId).filter((x): x is string => !!x);
  const sorted = [...allLocalIds].sort();
  const idRange: [string, string] | null = sorted.length ? [sorted[0], sorted[sorted.length - 1]] : null;
  return {
    keys,
    mode,
    diagnostics: {
      chunkIndex,
      mode,
      reason,
      idRange,
      totalParsed: llmIds.length,
      missingIds,
      duplicateIds,
      allLocalIds,
      autoFilledCount,
      modelProvidedCount,
      ambiguousIds,
      outOfOrderPositions
    }
  };
}

function toRefArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string' && v.trim()) return [v];
  return [];
}

/**
 * Langkah 3: petakan nomor lokal -> evidence_id final.
 * `evidence` dan `keys` harus sejajar (indeks sama).
 * Referensi dipetakan hanya di dalam chunk yang sama.
 */
export function remapRelatedIds<T extends HasRelated>(
  evidence: T[],
  keys: LocalKey[],
  chunkDiagnostics: ChunkKeyDiagnostics[] = []
): { evidence: T[]; stats: RemapStats } {
  if (evidence.length !== keys.length) {
    throw new Error(
      `remapRelatedIds: panjang evidence (${evidence.length}) != keys (${keys.length})`
    );
  }

  const map = new Map<string, string>(); // "chunk:E###" -> final id
  evidence.forEach((ev, i) => {
    const k = keys[i];
    if (k.localId && ev.evidence_id) map.set(`${k.chunkIndex}:${k.localId}`, ev.evidence_id);
  });

  // Toleran terhadap pemanggilan lama (mis. array string): hanya objek berdiagnostik yang dipakai.
  const validDiag = (Array.isArray(chunkDiagnostics) ? chunkDiagnostics : []).filter(
    (d): d is ChunkKeyDiagnostics => !!d && typeof d === 'object' && Array.isArray((d as any).allLocalIds)
  );
  const diagByChunk = new Map(validDiag.map(d => [d.chunkIndex, d]));
  const allIdsByChunk = new Map(validDiag.map(d => [d.chunkIndex, new Set(d.allLocalIds)]));
  const modeByChunk = new Map<number, 'llm-ids' | 'position'>();
  for (const k of keys) if (!modeByChunk.has(k.chunkIndex)) modeByChunk.set(k.chunkIndex, k.mode);
  const chunksWithoutDiag = [...modeByChunk.keys()].filter(ci => !diagByChunk.has(ci));
  if (chunksWithoutDiag.length > 0) {
    console.warn(
      `⚠️ remapRelatedIds: diagnostik chunk ${chunksWithoutDiag.map(c => c + 1).join(', ')} tidak diterima; ` +
      `referensi terbuang tidak bisa dibedakan antara 'item terbuang' dan 'nomor tak ada'. ` +
      `Periksa bahwa buildChunkLocalKeys().diagnostics di-push ke array yang dikirim sebagai argumen ke-3.`
    );
  }
  const perChunkMap = new Map<number, ChunkRemapStats>();
  const chunkStats = (ci: number): ChunkRemapStats => {
    let c = perChunkMap.get(ci);
    if (!c) {
      const d = diagByChunk.get(ci);
            c = {
        chunkIndex: ci,
        mode: modeByChunk.get(ci) ?? d?.mode ?? 'position',
        reason: d?.reason ?? 'unknown',
        itemsAccepted: 0,
        emitted: 0,
        mapped: 0,
        droppedTargetRemoved: 0,
        droppedTargetNonexistent: 0,
        droppedTargetUnclassified: 0,
        droppedUnparseable: 0,
        droppedSelf: 0,
        droppedDuplicate: 0,
        droppedAmbiguous: 0,
        samples: []
      };
      perChunkMap.set(ci, c);
    }
    return c;
  };

    const stats: RemapStats = {
    totalRefs: 0,
    mapped: 0,
    droppedUnknown: 0,
    droppedSelf: 0,
    droppedDuplicate: 0,
    droppedAmbiguous: 0,
    chunksUsingLlmIds: [...modeByChunk.values()].filter(m => m === 'llm-ids').length,
    chunksUsingPosition: [...modeByChunk.values()].filter(m => m === 'position').length,
    perChunk: [],
    evidenceWithRawRefs: new Set<string>(),
    evidenceWithMappedRefs: new Set<string>()
  };

    const out = evidence.map((ev, i) => {
    const cs = chunkStats(keys[i].chunkIndex);
    cs.itemsAccepted++;
    const raw = toRefArray(ev.related_evidence_ids);
    const evId = ev.evidence_id ?? null;

    if (raw.length === 0) return { ...ev, related_evidence_ids: null };

    // Self-reference detection helpers. Dua jalur karena LLM bisa menulis
    // ref dalam dua bentuk:
    //   (a) local ID ("E003") — normal, sesuai skema.
    //   (b) final ID ("Bmgp2VZufRY-E003") — hallucination pattern yang
    //       teramati di produksi.
    // Tanpa dua jalur ini, self-reference yang menunjuk evidence yang
    // sudah di-quarantine (atau berformat final ID) terklasifikasi
    // sebagai 'target-removed', bukan 'droppedSelf'.
    const myLocalIdFromKey = keys[i].localId;
    const myLocalIdFromFinal = evId ? normalizeLocalId(evId) : null;

    // BARU: catat bahwa LLM menulis refs untuk evidence ini.
    if (evId) stats.evidenceWithRawRefs.add(evId);

    const seen = new Set<string>();
    const result: string[] = [];
    const note = (ref: string, reason: DroppedRef['reason']) => {
      if (cs.samples.length < 8) cs.samples.push({ from: ev.evidence_id ?? '?', ref, reason });
    };
        for (const r of raw) {
      stats.totalRefs++;
      cs.emitted++;
      const local = normalizeLocalId(r);

      // ── Ambiguous check DULU ─────────────────────────────────
      // Jika local ID ambigu (duplikat, collision auto-fill+model, atau
      // model+model), kita tidak bisa yakin ID mana yang dimaksud model.
      // Cek ini SEBELUM self-reference agar diagnosis akurat: reference
      // ke ID ambigu harus di-drop sebagai 'ambiguous' meskipun kebetulan
      // sama dengan ID lokal sumber.
      const diag = diagByChunk.get(keys[i].chunkIndex);
      if (local && diag?.ambiguousIds?.includes(local)) {
        stats.droppedAmbiguous++;
        cs.droppedAmbiguous++;
        note(String(r), 'ambiguous');
        continue;
      }

      // ── Self-reference check ────────────────────────────────
      // Dua jalur deteksi:
      //   (a) local === keys[i].localId  → model menulis local ID sendiri
      //   (b) local === myLocalIdFromFinal → model menulis final ID sendiri
      //                                      (mis. "Bmgp2VZufRY-E111")
      if (
        local &&
        (local === myLocalIdFromKey || local === myLocalIdFromFinal)
      ) {
        stats.droppedSelf++;
        cs.droppedSelf++;
        continue;
      }

      const finalId = local ? map.get(`${keys[i].chunkIndex}:${local}`) : undefined;
      if (!finalId) {
        stats.droppedUnknown++;
        if (!local) {
          cs.droppedUnparseable++;
          note(String(r), 'unparseable');
        } else if (!allIdsByChunk.has(keys[i].chunkIndex)) {
          cs.droppedTargetUnclassified++;
          note(String(r), 'target-unclassified');
        } else if (allIdsByChunk.get(keys[i].chunkIndex)!.has(local)) {
          cs.droppedTargetRemoved++;
          note(String(r), 'target-removed');
        } else {
          cs.droppedTargetNonexistent++;
          note(String(r), 'target-nonexistent');
        }
        continue;
      }
      // Catatan: cek `finalId === ev.evidence_id` yang lama sudah tidak
      // diperlukan -- jalur (a) di atas mencakupnya, dan jalur (b)
      // mencakup kasus ketika LLM menulis final ID sendiri.
      if (seen.has(finalId)) {
        stats.droppedDuplicate++;
        cs.droppedDuplicate++;
        continue;
      }
      seen.add(finalId);
      result.push(finalId);
      stats.mapped++;
      cs.mapped++;
    }

    // BARU: catat evidence yang setelah remap masih punya ref valid.
    if (evId && result.length > 0) stats.evidenceWithMappedRefs.add(evId);

    return { ...ev, related_evidence_ids: result.length ? result : null };
  });

  stats.perChunk = [...perChunkMap.values()].sort((a, b) => a.chunkIndex - b.chunkIndex);
  return { evidence: out as T[], stats };
}

export interface RedirectDiagnostics {
  /** ID yang punya >1 tujuan akhir berbeda (konflik pemetaan). Ref ke ID ini dibuang. */
  ambiguousIds: string[];
  /** ID yang berada dalam siklus redirect. Ref ke ID ini dibuang. */
  cyclicIds: string[];
}

type RedirectResolution =
  | { status: 'ok'; id: string }
  | { status: 'ambiguous' }
  | { status: 'cyclic' };

/**
 * Langkah 4: setelah duplicate gate.
 * - id yang dihapus sebagai duplikat -> diarahkan ke kept_evidence_id
 * - semua anggota merge (merged_from_ids, fallback [a, b]) -> merged_evidence_id
 * - rantai redirect diikuti sampai id yang masih ada, tanpa batas hop
 * - siklus dan konflik (satu id ke dua tujuan akhir berbeda) dibuang secara
 *   deterministik, tidak bergantung urutan `removed`/`merged`
 * - id yang masih ada di hasil akhir TIDAK pernah di-redirect (alive wins)
 * - referensi ke id yang tidak ada di hasil akhir, ke diri sendiri,
 *   atau ganda -> dibuang
 */
export function redirectRelatedIds<T extends HasRelated>(
  preserved: T[],
  removed: Array<{ evidence_id: string; kept_evidence_id: string }>,
  merged: Array<{
    evidence_id_a: string;
    evidence_id_b: string;
    merged_evidence_id: string;
    merged_from_ids?: string[];
  }>
): { evidence: T[]; dropped: number; diagnostics: RedirectDiagnostics } {
  // Graf redirect: id -> himpunan tujuan langsung.
  const direct = new Map<string, Set<string>>();
  const addEdge = (from: string | null | undefined, to: string | null | undefined) => {
    if (!from || !to || from === to) return;
    let set = direct.get(from);
    if (!set) {
      set = new Set();
      direct.set(from, set);
    }
    set.add(to);
  };

  for (const r of removed) addEdge(r.evidence_id, r.kept_evidence_id);
  for (const m of merged) {
    const members = new Set<string>([
      m.evidence_id_a,
      m.evidence_id_b,
      ...(m.merged_from_ids ?? [])
    ]);
    for (const member of members) addEdge(member, m.merged_evidence_id);
  }

  const finalIds = new Set(preserved.map(e => e.evidence_id).filter(Boolean) as string[]);

  const memo = new Map<string, RedirectResolution>();
  const resolve = (id: string, path: Set<string>): RedirectResolution => {
    if (finalIds.has(id)) return { status: 'ok', id };
    const cached = memo.get(id);
    if (cached) return cached;

    const targets = direct.get(id);
    if (!targets) return { status: 'ok', id }; // ujung rantai; dicek terhadap finalIds oleh pemanggil
    if (path.has(id)) return { status: 'cyclic' };

    path.add(id);
    const results = [...targets].map(t => resolve(t, path));
    path.delete(id);

    let out: RedirectResolution;
    if (results.some(r => r.status === 'cyclic')) {
      out = { status: 'cyclic' };
    } else if (results.some(r => r.status === 'ambiguous')) {
      out = { status: 'ambiguous' };
    } else {
      const ends = new Set(results.map(r => (r as { id: string }).id));
      out = ends.size === 1
        ? { status: 'ok', id: [...ends][0] }
        : { status: 'ambiguous' };
    }
    memo.set(id, out);
    return out;
  };

  const ambiguousIds = new Set<string>();
  const cyclicIds = new Set<string>();
  let dropped = 0;

  const evidence = preserved.map(ev => {
    const raw = toRefArray(ev.related_evidence_ids);
    if (raw.length === 0) return ev;
    const seen = new Set<string>();
    const result: string[] = [];
    for (const r of raw) {
      const res = resolve(r, new Set());
      if (res.status === 'ambiguous') {
        ambiguousIds.add(r);
        dropped++;
        continue;
      }
      if (res.status === 'cyclic') {
        cyclicIds.add(r);
        dropped++;
        continue;
      }
      const target = res.id;
      if (!finalIds.has(target) || target === ev.evidence_id || seen.has(target)) {
        dropped++;
        continue;
      }
      seen.add(target);
      result.push(target);
    }
    return { ...ev, related_evidence_ids: result.length ? result : null };
  });

  return {
    evidence: evidence as T[],
    dropped,
    diagnostics: {
      ambiguousIds: [...ambiguousIds].sort(),
      cyclicIds: [...cyclicIds].sort()
    }
  };
}

/**
 * Langkah 5: setelah semua gate yang bisa mengeluarkan evidence dari hasil
 * akhir (duplicate gate, timestamp gate). Buang referensi yang targetnya
 * tidak ada di `evidence`, ke diri sendiri, atau ganda.
 *
 * Tidak mengarantina apa pun: kegagalan satu evidence tidak merambat ke
 * evidence yang merujuknya. Objek yang tidak berubah dikembalikan apa adanya
 * (referensi sama).
 */
export function pruneDanglingRelatedIds<T extends HasRelated>(
  evidence: T[]
): { evidence: T[]; dropped: number } {
  const finalIds = new Set(
    evidence.map(e => e.evidence_id).filter(Boolean) as string[]
  );
  let dropped = 0;

  const out = evidence.map(ev => {
    const raw = toRefArray(ev.related_evidence_ids);
    if (raw.length === 0) return ev;

    const seen = new Set<string>();
    const kept: string[] = [];
    for (const r of raw) {
      if (!finalIds.has(r) || r === ev.evidence_id || seen.has(r)) {
        dropped++;
        continue;
      }
      seen.add(r);
      kept.push(r);
    }

    if (kept.length === raw.length && Array.isArray(ev.related_evidence_ids)) {
      return ev;
    }
    return { ...ev, related_evidence_ids: kept.length ? kept : null };
  });

  return { evidence: out as T[], dropped };
}
