
import { describe, test, expect } from 'vitest';
import {
  normalizeLocalId,
  buildChunkLocalKeys,
  remapRelatedIds,
  redirectRelatedIds,
  type LocalKey
} from '../related-ids';

describe('RELATED IDS: normalizeLocalId', () => {
  test('PASS: normalisasi ID lokal tiga digit', () => {
    expect(normalizeLocalId('E001')).toBe('E001');
  });

  test('PASS: normalisasi huruf kecil dan angka kurang dari tiga digit', () => {
    expect(normalizeLocalId('e31')).toBe('E031');
  });

  test('PASS: ekstraksi ID lokal dari final evidence ID', () => {
    expect(normalizeLocalId('Bmgp2VZufRY-E031')).toBe('E031');
  });

  test('PASS: whitespace di sekitar ID diabaikan', () => {
    expect(normalizeLocalId('  E007  ')).toBe('E007');
  });

  test('PASS: ID dengan enam digit tetap dikenali', () => {
    expect(normalizeLocalId('E123456')).toBe('E123456');
  });

  test('PASS: nilai non-string menghasilkan null', () => {
    expect(normalizeLocalId(null)).toBeNull();
    expect(normalizeLocalId(undefined)).toBeNull();
    expect(normalizeLocalId(31)).toBeNull();
    expect(normalizeLocalId({ evidence_id: 'E001' })).toBeNull();
  });

  test('PASS: string tanpa pola ID menghasilkan null', () => {
    expect(normalizeLocalId('evidence-001')).toBeNull();
    expect(normalizeLocalId('')).toBeNull();
    expect(normalizeLocalId('   ')).toBeNull();
  });
});

describe('RELATED IDS: buildChunkLocalKeys', () => {
  test('PASS: semua ID tersedia dan unik menggunakan llm-ids', () => {
    const result = buildChunkLocalKeys(
      [
        { evidence_id: 'E001' },
        { evidence_id: 'E003' },
        { evidence_id: 'E007' }
      ],
      0
    );

    expect(result.mode).toBe('llm-ids');
    expect(result.diagnostics.reason).toBe('ok');
    expect(result.diagnostics.totalParsed).toBe(3);
    expect(result.diagnostics.missingIds).toBe(0);
    expect(result.diagnostics.duplicateIds).toEqual([]);
    expect(result.diagnostics.allLocalIds).toEqual([
      'E001',
      'E003',
      'E007'
    ]);
    expect(result.diagnostics.idRange).toEqual(['E001', 'E007']);

    expect(result.keys.map(k => k.localId)).toEqual([
      'E001',
      'E003',
      'E007'
    ]);
    expect(result.keys.map(k => k.position)).toEqual([1, 2, 3]);
    expect(result.keys.every(k => k.mode === 'llm-ids')).toBe(true);
  });

  test('PASS: ID kosong menyebabkan seluruh chunk fallback ke posisi', () => {
    const result = buildChunkLocalKeys(
      [
        { evidence_id: 'E001' },
        { evidence_id: '' },
        { evidence_id: 'E009' }
      ],
      2
    );

    expect(result.mode).toBe('position');
    expect(result.diagnostics.reason).toBe('missing-ids');
    expect(result.diagnostics.missingIds).toBe(1);
    expect(result.diagnostics.duplicateIds).toEqual([]);

    expect(result.keys.map(k => k.localId)).toEqual([
      'E001',
      'E002',
      'E003'
    ]);
    expect(result.keys.every(k => k.mode === 'position')).toBe(true);
    expect(result.keys.every(k => k.chunkIndex === 2)).toBe(true);
  });

  test('PASS: ID null dan undefined dihitung sebagai missing', () => {
    const result = buildChunkLocalKeys(
      [
        { evidence_id: null },
        {},
        { evidence_id: 'E003' }
      ],
      0
    );

    expect(result.mode).toBe('position');
    expect(result.diagnostics.reason).toBe('missing-ids');
    expect(result.diagnostics.missingIds).toBe(2);
    expect(result.keys.map(k => k.localId)).toEqual([
      'E001',
      'E002',
      'E003'
    ]);
  });

  test('PASS: ID duplikat menyebabkan seluruh chunk fallback ke posisi', () => {
    const result = buildChunkLocalKeys(
      [
        { evidence_id: 'E001' },
        { evidence_id: 'E001' },
        { evidence_id: 'E003' }
      ],
      0
    );

    expect(result.mode).toBe('position');
    expect(result.diagnostics.reason).toBe('duplicate-ids');
    expect(result.diagnostics.duplicateIds).toEqual(['E001']);

    expect(result.keys.map(k => k.localId)).toEqual([
      'E001',
      'E002',
      'E003'
    ]);
    expect(result.keys.every(k => k.mode === 'position')).toBe(true);
  });

  test('PASS: duplikat setelah normalisasi tetap terdeteksi', () => {
    const result = buildChunkLocalKeys(
      [
        { evidence_id: 'E031' },
        { evidence_id: 'e31' }
      ],
      0
    );

    expect(result.mode).toBe('position');
    expect(result.diagnostics.reason).toBe('duplicate-ids');
    expect(result.diagnostics.duplicateIds).toEqual(['E031']);
  });

  test('PASS: chunk kosong menghasilkan empty-chunk', () => {
    const result = buildChunkLocalKeys([], 4);

    expect(result.mode).toBe('position');
    expect(result.diagnostics.reason).toBe('empty-chunk');
    expect(result.diagnostics.totalParsed).toBe(0);
    expect(result.diagnostics.idRange).toBeNull();
    expect(result.keys).toEqual([]);
  });

  test('PASS: ID unik yang tidak berurutan tetap dipertahankan', () => {
  const result = buildChunkLocalKeys(
    [
      { evidence_id: 'E009' },
      { evidence_id: 'E002' },
      { evidence_id: 'E001' }
    ],
    0
  );

  // ID unik yang out-of-order tetap dipakai untuk remapping.
  // Diagnosis out-of-order dicatat di `outOfOrderPositions` (Patch D),
  // tapi TIDAK mengubah mode atau ID lokal — ini preserve + diagnose.
  expect(result.mode).toBe('llm-ids');
  expect(result.diagnostics.reason).toBe('ok');
  expect(result.keys.map(k => k.localId)).toEqual([
    'E009',
    'E002',
    'E001'
  ]);
  // Tambahan opsional (assertion untuk diagnosis):
  expect(result.diagnostics.outOfOrderPositions).toEqual([1, 3]);
});

  test('PASS: nomor lokal sama pada chunk berbeda tetap terisolasi', () => {
    const chunkA = buildChunkLocalKeys(
      [{ evidence_id: 'E001' }],
      0
    );
    const chunkB = buildChunkLocalKeys(
      [{ evidence_id: 'E001' }],
      1
    );

    expect(chunkA.keys[0].chunkIndex).toBe(0);
    expect(chunkB.keys[0].chunkIndex).toBe(1);
    expect(chunkA.keys[0].localId).toBe('E001');
    expect(chunkB.keys[0].localId).toBe('E001');
  });
});

describe('RELATED IDS: remapRelatedIds', () => {
  const makeKey = (
    chunkIndex: number,
    localId: string,
    position: number
  ): LocalKey => ({
    chunkIndex,
    localId,
    position,
    mode: 'llm-ids'
  });

  test('PASS: referensi lokal dipetakan ke final evidence ID', () => {
    const evidence = [
      {
        evidence_id: 'VIDEO-E001',
        related_evidence_ids: ['E002']
      },
      {
        evidence_id: 'VIDEO-E002',
        related_evidence_ids: null
      }
    ];

    const keys = [
      makeKey(0, 'E001', 1),
      makeKey(0, 'E002', 2)
    ];

    const diagnostics = buildChunkLocalKeys(
      [
        { evidence_id: 'E001' },
        { evidence_id: 'E002' }
      ],
      0
    ).diagnostics;

    const result = remapRelatedIds(evidence, keys, [diagnostics]);

    expect(result.evidence[0].related_evidence_ids).toEqual([
      'VIDEO-E002'
    ]);
    expect(result.evidence[1].related_evidence_ids).toBeNull();

    expect(result.stats.totalRefs).toBe(1);
    expect(result.stats.mapped).toBe(1);
    expect(result.stats.droppedUnknown).toBe(0);
    expect(result.stats.evidenceWithRawRefs.has('VIDEO-E001')).toBe(true);
    expect(result.stats.evidenceWithMappedRefs.has('VIDEO-E001')).toBe(true);
  });

  test('PASS: referensi ke target yang dibuang dibedakan dari target tidak ada', () => {
    const evidence = [
      {
        evidence_id: 'VIDEO-E001',
        related_evidence_ids: ['E002', 'E009']
      }
    ];

    const keys = [
      makeKey(0, 'E001', 1)
    ];

    const diagnostics = buildChunkLocalKeys(
      [
        { evidence_id: 'E001' },
        { evidence_id: 'E002' },
        { evidence_id: 'E003' }
      ],
      0
    ).diagnostics;

    const result = remapRelatedIds(evidence, keys, [diagnostics]);

    expect(result.evidence[0].related_evidence_ids).toBeNull();
    expect(result.stats.droppedUnknown).toBe(2);

    expect(result.stats.perChunk[0].droppedTargetRemoved).toBe(1);
    expect(result.stats.perChunk[0].droppedTargetNonexistent).toBe(1);
    expect(result.stats.perChunk[0].samples).toEqual([
      {
        from: 'VIDEO-E001',
        ref: 'E002',
        reason: 'target-removed'
      },
      {
        from: 'VIDEO-E001',
        ref: 'E009',
        reason: 'target-nonexistent'
      }
    ]);

    expect(result.stats.evidenceWithRawRefs.has('VIDEO-E001')).toBe(true);
    expect(result.stats.evidenceWithMappedRefs.has('VIDEO-E001')).toBe(false);
  });

  test('PASS: referensi lintas chunk tidak dipetakan', () => {
    const evidence = [
      {
        evidence_id: 'VIDEO-A-E001',
        related_evidence_ids: ['E002']
      },
      {
        evidence_id: 'VIDEO-B-E002',
        related_evidence_ids: null
      }
    ];

    const keys = [
      makeKey(0, 'E001', 1),
      makeKey(1, 'E002', 1)
    ];

    const diagnostics = [
      buildChunkLocalKeys([{ evidence_id: 'E001' }], 0).diagnostics,
      buildChunkLocalKeys([{ evidence_id: 'E002' }], 1).diagnostics
    ];

    const result = remapRelatedIds(evidence, keys, diagnostics);

    expect(result.evidence[0].related_evidence_ids).toBeNull();
    expect(result.stats.droppedUnknown).toBe(1);
    expect(result.stats.perChunk[0].droppedTargetNonexistent).toBe(1);
  });

  test('PASS: self-reference lokal dibuang', () => {
    const evidence = [
      {
        evidence_id: 'VIDEO-E001',
        related_evidence_ids: ['E001']
      }
    ];

    const result = remapRelatedIds(
      evidence,
      [makeKey(0, 'E001', 1)],
      [
        buildChunkLocalKeys([{ evidence_id: 'E001' }], 0).diagnostics
      ]
    );

    expect(result.evidence[0].related_evidence_ids).toBeNull();
    expect(result.stats.droppedSelf).toBe(1);
    expect(result.stats.mapped).toBe(0);
  });

  test('PASS: self-reference dalam bentuk final ID dibuang', () => {
    const evidence = [
      {
        evidence_id: 'VIDEO-E001',
        related_evidence_ids: ['OTHER-VIDEO-E001']
      }
    ];

    const result = remapRelatedIds(
      evidence,
      [makeKey(0, 'E001', 1)],
      [
        buildChunkLocalKeys([{ evidence_id: 'E001' }], 0).diagnostics
      ]
    );

    expect(result.evidence[0].related_evidence_ids).toBeNull();
    expect(result.stats.droppedSelf).toBe(1);
  });

  test('PASS: referensi ganda ke target yang sama hanya dipetakan sekali', () => {
    const evidence = [
      {
        evidence_id: 'VIDEO-E001',
        related_evidence_ids: ['E002', 'e002', 'VIDEO-E002']
      },
      {
        evidence_id: 'VIDEO-E002',
        related_evidence_ids: null
      }
    ];

    const result = remapRelatedIds(
      evidence,
      [
        makeKey(0, 'E001', 1),
        makeKey(0, 'E002', 2)
      ],
      [
        buildChunkLocalKeys(
          [
            { evidence_id: 'E001' },
            { evidence_id: 'E002' }
          ],
          0
        ).diagnostics
      ]
    );

    expect(result.evidence[0].related_evidence_ids).toEqual([
      'VIDEO-E002'
    ]);
    expect(result.stats.mapped).toBe(1);
    expect(result.stats.droppedDuplicate).toBe(2);
  });

  test('PASS: referensi yang tidak dapat diparse dicatat sebagai unparseable', () => {
    const evidence = [
      {
        evidence_id: 'VIDEO-E001',
        related_evidence_ids: ['not-an-id']
      }
    ];

    const result = remapRelatedIds(
      evidence,
      [makeKey(0, 'E001', 1)],
      [
        buildChunkLocalKeys([{ evidence_id: 'E001' }], 0).diagnostics
      ]
    );

    expect(result.evidence[0].related_evidence_ids).toBeNull();
    expect(result.stats.perChunk[0].droppedUnparseable).toBe(1);
    expect(result.stats.perChunk[0].samples[0].reason).toBe('unparseable');
  });

  test('PASS: jumlah evidence dan keys yang tidak sejajar menghasilkan error', () => {
    expect(() =>
      remapRelatedIds(
        [{ evidence_id: 'VIDEO-E001', related_evidence_ids: null }],
        [],
        []
      )
    ).toThrow(
      'remapRelatedIds: panjang evidence (1) != keys (0)'
    );
  });

  test('PASS: tanpa diagnostik, target yang tidak ditemukan diklasifikasikan unclassified', () => {
    const evidence = [
      {
        evidence_id: 'VIDEO-E001',
        related_evidence_ids: ['E002']
      }
    ];

    const result = remapRelatedIds(
      evidence,
      [makeKey(0, 'E001', 1)]
    );

    expect(result.evidence[0].related_evidence_ids).toBeNull();
    expect(result.stats.perChunk[0].droppedTargetUnclassified).toBe(1);
  });

  test('PASS: evidence tanpa raw refs tidak masuk tracking Set', () => {
    const evidence = [
      {
        evidence_id: 'VIDEO-E001',
        related_evidence_ids: null
      }
    ];

    const result = remapRelatedIds(
      evidence,
      [makeKey(0, 'E001', 1)],
      [
        buildChunkLocalKeys([{ evidence_id: 'E001' }], 0).diagnostics
      ]
    );

    expect(result.stats.evidenceWithRawRefs.size).toBe(0);
    expect(result.stats.evidenceWithMappedRefs.size).toBe(0);
  });

  test('PASS: array ref kosong diperlakukan sebagai tidak ada ref', () => {
    const evidence = [
      {
        evidence_id: 'VIDEO-E001',
        related_evidence_ids: []
      }
    ];

    const result = remapRelatedIds(
      evidence,
      [makeKey(0, 'E001', 1)],
      [
        buildChunkLocalKeys([{ evidence_id: 'E001' }], 0).diagnostics
      ]
    );

    expect(result.evidence[0].related_evidence_ids).toBeNull();
    expect(result.stats.totalRefs).toBe(0);
    expect(result.stats.evidenceWithRawRefs.size).toBe(0);
  });
});

describe('RELATED IDS: redirectRelatedIds', () => {
  test('PASS: referensi ke evidence yang dihapus diarahkan ke evidence yang dipertahankan', () => {
    const preserved = [
      {
        evidence_id: 'VIDEO-E001',
        related_evidence_ids: ['VIDEO-E002']
      },
      {
        evidence_id: 'VIDEO-E003',
        related_evidence_ids: null
      }
    ];

    const result = redirectRelatedIds(
      preserved,
      [
        {
          evidence_id: 'VIDEO-E002',
          kept_evidence_id: 'VIDEO-E003'
        }
      ],
      []
    );

    expect(result.evidence[0].related_evidence_ids).toEqual([
      'VIDEO-E003'
    ]);
    expect(result.dropped).toBe(0);
  });

  test('PASS: referensi ke dua evidence yang di-merge diarahkan ke hasil merge', () => {
    const preserved = [
      {
        evidence_id: 'VIDEO-E001',
        related_evidence_ids: [
          'VIDEO-E002',
          'VIDEO-E003'
        ]
      },
      {
        evidence_id: 'VIDEO-E004',
        related_evidence_ids: null
      }
    ];

    const result = redirectRelatedIds(
      preserved,
      [],
      [
        {
          evidence_id_a: 'VIDEO-E002',
          evidence_id_b: 'VIDEO-E003',
          merged_evidence_id: 'VIDEO-MERGED-001'
        }
      ]
    );

    // Target hasil merge tidak ada dalam preserved sehingga dibuang.
    expect(result.evidence[0].related_evidence_ids).toBeNull();
    expect(result.dropped).toBe(2);
  });

  test('PASS: referensi yang tidak ada dalam hasil akhir dibuang', () => {
    const preserved = [
      {
        evidence_id: 'VIDEO-E001',
        related_evidence_ids: ['VIDEO-E999']
      }
    ];

    const result = redirectRelatedIds(preserved, [], []);

    expect(result.evidence[0].related_evidence_ids).toBeNull();
    expect(result.dropped).toBe(1);
  });

  test('PASS: self-reference dibuang', () => {
    const preserved = [
      {
        evidence_id: 'VIDEO-E001',
        related_evidence_ids: ['VIDEO-E001']
      }
    ];

    const result = redirectRelatedIds(preserved, [], []);

    expect(result.evidence[0].related_evidence_ids).toBeNull();
    expect(result.dropped).toBe(1);
  });

  
test('PASS: referensi duplikat setelah redirect hanya dipertahankan sekali', () => {
    const preserved = [
        {
        evidence_id: 'VIDEO-E001',
        related_evidence_ids: [
            'VIDEO-E002',
            'VIDEO-E003'
        ]
        },
        {
        evidence_id: 'VIDEO-E002',
        related_evidence_ids: null
        }
    ];

    const result = redirectRelatedIds(
        preserved,
        [
        {
            evidence_id: 'VIDEO-E003',
            kept_evidence_id: 'VIDEO-E002'
        }
        ],
        []
    );

    expect(result.evidence[0].related_evidence_ids).toEqual([
        'VIDEO-E002'
    ]);
    expect(result.dropped).toBe(1);
    });


  test('PASS: evidence tanpa refs tidak berubah', () => {
    const original = {
      evidence_id: 'VIDEO-E001',
      related_evidence_ids: null
    };

    const result = redirectRelatedIds([original], [], []);

    expect(result.evidence[0]).toBe(original);
    expect(result.dropped).toBe(0);
  });
});

describe('RELATED IDS: redirectRelatedIds — chain, merge, siklus, konflik', () => {
  const ev = (id: string, refs: string[] | null = null) => ({
    evidence_id: id,
    related_evidence_ids: refs
  });

  test('MERGE 3 anggota: semua anggota di merged_from_ids diarahkan ke hasil merge', () => {
    const preserved = [
      ev('E001'),                 // evidence hasil merge (mewarisi ID evidenceA)
      ev('E004', ['E003']),
      ev('E005', ['E002'])
    ];

    const result = redirectRelatedIds(
      preserved,
      [],
      [{
        evidence_id_a: 'E001',
        evidence_id_b: 'E002',
        merged_evidence_id: 'E001',
        merged_from_ids: ['E001', 'E002', 'E003']
      }]
    );

    expect(result.evidence[1].related_evidence_ids).toEqual(['E001']);
    expect(result.evidence[2].related_evidence_ids).toEqual(['E001']);
    expect(result.dropped).toBe(0);
  });

  test('MERGE 4 anggota: referensi ke dua anggota sekaligus digabung jadi satu', () => {
    const result = redirectRelatedIds(
      [ev('E001'), ev('E009', ['E003', 'E004'])],
      [],
      [{
        evidence_id_a: 'E001',
        evidence_id_b: 'E002',
        merged_evidence_id: 'E001',
        merged_from_ids: ['E001', 'E002', 'E003', 'E004']
      }]
    );

    expect(result.evidence[1].related_evidence_ids).toEqual(['E001']);
    expect(result.dropped).toBe(1); // duplikat setelah redirect
  });

  test('kompatibilitas: MERGE tanpa merged_from_ids memakai fallback [a, b]', () => {
    const result = redirectRelatedIds(
      [ev('E001'), ev('E004', ['E002', 'E003'])],
      [],
      [{
        evidence_id_a: 'E002',
        evidence_id_b: 'E003',
        merged_evidence_id: 'E001'
      }]
    );

    expect(result.evidence[1].related_evidence_ids).toEqual(['E001']);
    expect(result.dropped).toBe(1);
  });

  test('kompatibilitas: tanpa merged_from_ids, anggota ke-3 tidak diredirect (dibuang)', () => {
    const result = redirectRelatedIds(
      [ev('E001'), ev('E005', ['E003'])],
      [],
      [{
        evidence_id_a: 'E001',
        evidence_id_b: 'E002',
        merged_evidence_id: 'E001'
      }]
    );

    expect(result.evidence[1].related_evidence_ids).toBeNull();
    expect(result.dropped).toBe(1);
  });

  test('KEEP chain 7 hop (melewati batas lama 5) berakhir di evidence yang masih ada', () => {
    const removed = [];
    for (let i = 2; i <= 8; i++) {
      removed.push({
        evidence_id: `E00${i}`,
        kept_evidence_id: `E00${i - 1}`
      });
    }

    const result = redirectRelatedIds(
      [ev('E001'), ev('E009', ['E008'])],
      removed,
      []
    );

    expect(result.evidence[1].related_evidence_ids).toEqual(['E001']);
    expect(result.dropped).toBe(0);
  });

  test('hasil tidak bergantung urutan array removed (chain dibalik)', () => {
    const removed = [];
    for (let i = 8; i >= 2; i--) {
      removed.push({
        evidence_id: `E00${i}`,
        kept_evidence_id: `E00${i - 1}`
      });
    }

    const result = redirectRelatedIds(
      [ev('E001'), ev('E009', ['E008'])],
      removed,
      []
    );

    expect(result.evidence[1].related_evidence_ids).toEqual(['E001']);
  });

  test('KEEP yang kept-nya kemudian dihapus oleh MERGE diselesaikan ke hasil merge', () => {
    const result = redirectRelatedIds(
      [ev('E001'), ev('E009', ['E005'])],
      [{ evidence_id: 'E005', kept_evidence_id: 'E002' }],
      [{
        evidence_id_a: 'E001',
        evidence_id_b: 'E002',
        merged_evidence_id: 'E001',
        merged_from_ids: ['E001', 'E002', 'E003']
      }]
    );

    expect(result.evidence[1].related_evidence_ids).toEqual(['E001']);
  });

  test('siklus redirect: referensi dibuang dan dicatat di diagnostics.cyclicIds', () => {
    const result = redirectRelatedIds(
      [ev('E001', ['E002'])],
      [
        { evidence_id: 'E002', kept_evidence_id: 'E003' },
        { evidence_id: 'E003', kept_evidence_id: 'E002' }
      ],
      []
    );

    expect(result.evidence[0].related_evidence_ids).toBeNull();
    expect(result.dropped).toBe(1);
    expect(result.diagnostics.cyclicIds).toContain('E002');
  });

  test('siklus tidak membuat loop tak hingga dan tidak mengganggu referensi sehat', () => {
    const result = redirectRelatedIds(
      [ev('E001', ['E002', 'E010']), ev('E010')],
      [
        { evidence_id: 'E002', kept_evidence_id: 'E003' },
        { evidence_id: 'E003', kept_evidence_id: 'E002' }
      ],
      []
    );

    expect(result.evidence[0].related_evidence_ids).toEqual(['E010']);
    expect(result.dropped).toBe(1);
  });

  test('konflik: satu ID dipetakan ke dua tujuan berbeda → dibuang (ambiguous)', () => {
    const removed = [{ evidence_id: 'E002', kept_evidence_id: 'E001' }];
    const merged = [{
      evidence_id_a: 'E002',
      evidence_id_b: 'E003',
      merged_evidence_id: 'E004'
    }];
    const preserved = [ev('E001'), ev('E004'), ev('E005', ['E002'])];

    const result = redirectRelatedIds(preserved, removed, merged);

    expect(result.evidence[2].related_evidence_ids).toBeNull();
    expect(result.dropped).toBe(1);
    expect(result.diagnostics.ambiguousIds).toContain('E002');
  });

  test('konflik: hasil identik walau urutan removed dibalik (deterministik)', () => {
    const removedAB = [
      { evidence_id: 'E002', kept_evidence_id: 'E001' },
      { evidence_id: 'E002', kept_evidence_id: 'E003' }
    ];
    const removedBA = [...removedAB].reverse();
    const preserved = [ev('E001'), ev('E003'), ev('E005', ['E002'])];

    const a = redirectRelatedIds(preserved, removedAB, []);
    const b = redirectRelatedIds(preserved, removedBA, []);

    expect(a.evidence[2].related_evidence_ids).toBeNull();
    expect(b.evidence[2].related_evidence_ids).toBeNull();
    expect(a.diagnostics.ambiguousIds).toEqual(b.diagnostics.ambiguousIds);
  });

  test('konflik semu: dua tujuan yang konvergen ke ID akhir sama → TIDAK ambiguous', () => {
    const result = redirectRelatedIds(
      [ev('E001'), ev('E005', ['E002'])],
      [
        { evidence_id: 'E002', kept_evidence_id: 'E001' },
        { evidence_id: 'E002', kept_evidence_id: 'E003' },
        { evidence_id: 'E003', kept_evidence_id: 'E001' }
      ],
      []
    );

    expect(result.evidence[1].related_evidence_ids).toEqual(['E001']);
    expect(result.diagnostics.ambiguousIds).toEqual([]);
  });

  test('ID yang masih ada tidak pernah di-redirect (alive wins)', () => {
    const result = redirectRelatedIds(
      [ev('E001'), ev('E002'), ev('E005', ['E002'])],
      [{ evidence_id: 'E002', kept_evidence_id: 'E001' }],
      []
    );

    expect(result.evidence[2].related_evidence_ids).toEqual(['E002']);
  });

  test('diagnostics kosong pada kasus normal', () => {
    const result = redirectRelatedIds([ev('E001', ['E001'])], [], []);

    expect(result.diagnostics).toEqual({ ambiguousIds: [], cyclicIds: [] });
  });
});