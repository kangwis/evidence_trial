import protectionList from './protection-list.json';

interface ProtectionList {
  version: string;
  description: string;
  sections: Record<string, string[]>;
  rules: {
    structure_immutable: string[];
    allowed_normalizations: Record<string, string>;
    fallback_rule: string;
  };
}

const list = protectionList as ProtectionList;

const SECTION_LABELS: Record<string, string> = {
  product_names: '[A] NAMA PRODUK',
  brand_names_must_preserve_capitalization: '[B] NAMA BRAND (JAGA KAPITALISASI)',
  components_and_materials: '[C] KOMPONEN & MATERIAL',
  software_and_ai_features: '[D] SOFTWARE & FITUR AI',
  camera_terms: '[E] KAMERA',
  vendor_attribution: '[F] ATRIBUSI VENDOR',
  evaluative_words: '[G] KATA EVALUATIF',
  technical_whitelist_phrases: '[H] FRASA TEKNIS WHITELIST',
  categorical_values: '[I] NILAI KATEGORIK',
  units: '[J] SATUAN & UNIT',
  range_and_compound_descriptors: '[K] RANGE & COMPOUND DESCRIPTOR',
  game_settings: '[L] PENGATURAN GAME',
  benchmark_and_games: '[M] BENCHMARK & GAME',
  numeric_precision: '[N] PRESISI NUMERIK'
};

const MANUALLY_RENDERED_SECTIONS = new Set(['removable_fillers']);

export function buildProtectionBlock(): string {
  const jsonKeys = Object.keys(list.sections);
  const knownKeys = Object.keys(SECTION_LABELS);
  const orphans = jsonKeys.filter(
    k => !knownKeys.includes(k) && !MANUALLY_RENDERED_SECTIONS.has(k)
  );
  if (orphans.length > 0) {
    console.warn(
      `⚠️ protection-list.json punya section yang tidak ter-render: ` +
      `${orphans.join(', ')}. Tambahkan ke SECTION_LABELS di srt-nlp-safe.ts.`
    );
  }
  
  return Object.entries(SECTION_LABELS)
    .map(([key, label]) => {
      const items = list.sections[key];
      if (!items || items.length === 0) return null;
      return `${label}:\n${items.join(', ')}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

export function buildAllowedNormalizations(): string {
  return Object.entries(list.rules.allowed_normalizations)
    .map(([from, to]) => `   - "${from}" -> "${to}"`)
    .join('\n');
}

export function buildSrtNlpSafeInstruction(): string {
  return `Anda adalah Data Prep Specialist untuk pipeline Evidence Extraction. Rapikan SRT berikut tanpa merusak sinyal yang dipakai validator.

==================================================
ATURAN STRUKTUR (MUTLAK)
==================================================
1. JANGAN ubah nomor indeks, timestamp, jumlah segmen, atau urutan segmen.
2. JANGAN gabung, pecah, hapus, atau tambah segmen.
3. JANGAN mengisi segmen kosong.
4. JANGAN menambahkan teks non-dialog seperti *(B-roll)*, [musik], dsb.
5. Perbaiki HANYA teks di dalam segmen.

==================================================
ATURAN TEKS
==================================================
6. Perbaiki HANYA: ejaan salah, typo, huruf kapital, tanda baca.
7. Tambahkan tanda baca untuk memisahkan klaim atomik (titik, koma, tanda tanya).
8. JANGAN memindahkan teks dari satu segmen ke segmen lain.
  Setiap segmen harus mempertahankan isi yang sama dengan aslinya.
9. JANGAN mengulang isi segmen di segmen berikutnya.
10. Kalau satu kalimat terpotong di dua segmen, biarkan terpotong.
  JANGAN satukan.
11. PERTAHANKAN GAYA BAHASA KASUAL: Jangan membakukan bahasa pembicara. 
12. Normalisasi yang DIIZINKAN:
${buildAllowedNormalizations()}

==================================================
NORMALISASI YANG DILARANG KERAS
==================================================
- JANGAN mengubah istilah teknis menjadi padanan angka atau singkatan.
  "Full HD" TETAP "Full HD", BUKAN "1080p".
  "FHD" TETAP "FHD", BUKAN "Full HD".
  "HD" TETAP "HD", BUKAN "720p".
  "4K" TETAP "4K", BUKAN "2160p".
  "QHD" TETAP "QHD", BUKAN "1440p".
- JANGAN mengubah notasi resolusi, refresh rate, atau frame rate.
- JANGAN mengubah kapitalisasi istilah produk atau brand.
  "Samsung plus" (kata sambung) TETAP "Samsung plus",
  JANGAN diubah jadi "Samsung Plus".
- JANGAN generalisasi dari daftar normalisasi yang diizinkan.
  Hanya ubah bentuk yang PERSIS tercantum. Selain itu, biarkan apa adanya.
- Jika ragu apakah sebuah perubahan diizinkan, JANGAN lakukan.
- JANGAN mengganti sinonim.
  "banget" TETAP "banget", BUKAN "sekali", BUKAN "sangat".
  "cakep" TETAP "cakep", BUKAN "bagus".
  "oke" TETAP "oke", BUKAN "baik".
  "satset" TETAP "satset", BUKAN "cepat".
- JANGAN melengkapi atau memperluas nama benchmark, brand, atau produk.
  "3D Extreme Stress Test" TETAP "3D Extreme Stress Test",
  BUKAN "3D Wild Life Extreme Stress Test".
  "AnTuTu" TETAP "AnTuTu", BUKAN "AnTuTu 10" atau "AnTuTu V10".
  "Geekbench 6" TETAP "Geekbench 6", BUKAN "Geekbench 6.3".
- JANGAN menambahkan kata yang tidak ada di sumber.
  Kalau reviewer tidak menyebut "Wild Life", JANGAN tambahkan.

==================================================
FILLER — HANYA INI YANG BOLEH DIHAPUS
==================================================
${list.sections.removable_fillers.join(', ')}

JANGAN hapus kata berikut karena dipakai sebagai sinyal:
banget, udah, aja, gitu, kayak, cukup, bagus, cakep, mantap,
kurang, tergolong, memadai, minim, agak, luar biasa, katanya,
ngeklaim, sayangnya.

BERSIHKAN STUTTER: Hapus pengulangan kata akibat gagap STT (contoh: \"karena memang karena kalau\" menjadi \"karena kalau\")

==================================================
PROTECTION LIST — JANGAN DIUBAH ATAU DIHAPUS
==================================================

${buildProtectionBlock()}

==================================================
ATURAN PENUTUP
==================================================
Jika ragu apakah sebuah kata termasuk PROTECTION LIST,
JANGAN ubah dan JANGAN hapus.
JANGAN merombak struktur kalimat pembicara.
JANGAN MENGHAPUS MAKNA/KALIMAT: Perbaiki ejaan yang salah dengar, 
jangan membuang kalimat atau menebak-nebak konteks di luar bahasan smartphone.

${list.rules.fallback_rule}

Output HANYA SRT. Tanpa penjelasan, tanpa tabel, tanpa komentar.`;
}
