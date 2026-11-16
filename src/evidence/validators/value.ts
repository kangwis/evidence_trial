// ============================================================
// VALUE VALIDATOR — v2.0
// ============================================================
// CHANGELOG v1.0 -> v2.0:
//   - Tambah UnitWhitelist check (SUSPECT HIGH) — menutup gap
//     "unit tidak dicek sama sekali" (temuan audit).
//   - Tambah NonNumericOrphan check (SUSPECT MEDIUM) — menutup gap
//     "value non-numerik tanpa unit lolos".
//   - N9/N15-N18 TETAP PASS (compatibility shim, sesuai keputusan
//     penulis asli). Setelah prompt v6.0 terbukti mengurangi
//     pelanggaran compound-in-value, whitelist ini bisa diubah
//     ke FAIL HIGH di rilis berikutnya.
//   - Semua komentar & alasan historis dipertahankan.
// ============================================================

import type { ValidationResult } from '../types';

// ------------------------------------------------------------
// UNIT WHITELIST — sinkron dengan prompt rule 7
// ------------------------------------------------------------
// Jika prompt rule 7 berubah, whitelist ini WAJIB di-update.
// Tambahan varian bahasa (hour/hours/h, second/s, minute/minutes/m)
// disertakan untuk kompatibilitas historis, tapi varian kanonik
// yang diharapkan model adalah versi Bahasa Indonesia.
const UNIT_WHITELIST = new Set<string>([
  // kamera / storage / dimensi
  'mp', 'gb', 'mb', 'tb', 'mm', 'nm', 'meter', 'm', 'cm', 'px', 'pixel', 'pixels',
  // waktu
  'menit', 'minute', 'minutes', 'm',
  'jam', 'hour', 'hours', 'h',
  'detik', 'second', 'seconds', 's',
  'kali', 'tahun',
  
  // performance/display/power
  'x', 'fps', 'nits', 'hz', 'khz', 'mhz', 'ghz', 'mah', 'w',
  'watt', 'watts',

  // persen (untuk volume/battery drain)
  '%',
  'persen',

  // Satuan Bahasa Indonesia yang sah tapi sempat hilang dari whitelist.
  'juta', 'jutaan', 'ribu', 'miliar', 'milyar', 'triliun',
  'hari', 'minggu', 'bulan',
  'gram', 'inci', 'celsius', 'derajat', 'derajat celsius', 'level', 'core',
  'mm persegi', 'generasi', 'generation',

  // Count classifiers (kata penghitung) — BUKAN satuan pengukuran teknis.
  // LLM konsisten menggunakan pattern "N [classifier]" untuk menghitung objek.
  // Ini konsisten dengan Rule 7 yang sudah mengizinkan "x", "kali", "core".
  'buah',     // "3 buah kamera"
  'game',     // "1 game"
  'varian',   // "2 pilihan varian"
  'speaker',  // "1 speaker"
  'kamera',   // "3 kamera belakang"
  'warna',    // "3 pilihan warna"

  // Benchmark score — variasi bahasa poin/point
  'poin',     // "918.340 poin"
  'point',    // "3.047 point"
  'points',   // "3.047 points"

  // Currency — termasuk mata uang asing yang muncul di review
  'rp', 'rupiah', 'idr',
  'dolar singapura', 'sgd',   // SGD = ISO code Dolar Singapura
]);

export const ValueValidator = {
  validate(
    value: string | number | null | undefined,
    unit: string | null | undefined,
    attribute?: string | null,
    _attribute_value?: string | number | null
  ): ValidationResult {
    const valueStr = String(value ?? '').trim();
    const unitStr = String(unit ?? '').trim();
    const attributeStr = String(attribute ?? '').trim();

    // ------------------------------------------------------------
    // CAMERA APERTURE: notasi f-number, misalnya 2.2 + unit "f".
    // "f" hanya sah untuk atribut bukaan kamera/aperture.
    // ------------------------------------------------------------
    if (
      isNumeric(valueStr) &&
      /^f$/i.test(unitStr) &&
      /\b(?:bukaan|aperture)\b/i.test(attributeStr)
    ) {
      return {
        pass: true,
        status: 'PASS',
        rule: 'VALUE',
        reason: 'Notasi f-number kamera dikenali sebagai bukaan lensa',
        severity: 'LOW'
      };
    }

    // ------------------------------------------------------------
    // N9: Compound resolution value — "2340 x 1080" dengan unit
    // "p", "pixel", atau "px".
    // ------------------------------------------------------------
    if (
      /^\d+\s*[x×]\s*\d+$/i.test(valueStr) &&
      /^(p|pixels?|px)$/i.test(unitStr)
    ) {
      return {
        pass: true,
        status: 'SUSPECT',
        rule: 'VALUE',
        reason:
          'Resolusi gabungan tidak sesuai kontrak value numerik tunggal; pindahkan representasi lengkap ke attribute_value',
        severity: 'MEDIUM'
      };
    }

    // ------------------------------------------------------------
    // N15: Compound video-mode value — "1080p 30 fps", "4K 30 fps",
    // "720p 240 fps" dengan unit "fps". Sama seperti N9 (resolusi
    // "2340 x 1080" + unit px), ini deskriptor MODE VIDEO majemuk
    // yang sah -- bukan error kompatibilitas value/unit.
    //
    // Dikonfirmasi dari data produksi 45hfkSE5DvA: pola ini menyumbang
    // 5 dari 21 quarantine (24%) dalam satu run (Test 5), SEMUANYA
    // dengan root cause identik. Ini bukan kasus tepi -- model secara
    // konsisten menaruh seluruh string mode ("1080p 60 fps") ke value
    // alih-alih angka fps saja, setiap kali mendeskripsikan resolusi
    // rekam video sebagai satu unit.
    //
    // CATATAN DESAIN: whitelist ini PASS, bukan reroute otomatis ke
    // attribute/attribute_value. Idealnya field ini memang milik
    // attribute_value (mode kategorik), bukan value/unit (skalar),
    // tapi ValueValidator tidak berwenang menulis ulang field lain.
    // Perbaikan struktural itu ranahnya prompt (instruksi eksplisit:
    // "mode video resolusi+fps → attribute_value, value/unit = null").
    // Prompt v6.0 sudah memperkuat instruksi ini di rule 7; setelah
    // terbukti efektif, whitelist ini bisa diubah ke FAIL HIGH.
    // ------------------------------------------------------------
    if (
      /^(4k|8k|2k|\d{3,4}p)\s+\d+\s*fps$/i.test(valueStr) &&
      /^fps$/i.test(unitStr)
    ) {   
      return {
        pass: true,
        status: 'SUSPECT',
        rule: 'VALUE',
        reason:
          'Mode video majemuk tidak sesuai kontrak value numerik tunggal; pindahkan representasi lengkap ke attribute_value',
        severity: 'MEDIUM'
      };
    }

    // ------------------------------------------------------------
    // N16: Durasi format jam:menit — "17:42", "25:02" dengan unit
    // "jam"/"hour"/"hours"/"h". Sama seperti N9/N15: ini deskriptor
    // durasi majemuk yang sah (jam+menit sebagai satu nilai), bukan
    // error kompatibilitas. atomicity.ts N2 SUDAH mengenali bentuk
    // "17 jam 42 menit" sebagai satu nilai komposit di level klaim --
    // ValueValidator belum mengenali representasi numeriknya.
    //
    // \d{1,2} sengaja tidak dibatasi ke rentang 0-23, karena ini
    // DURASI KUMULATIF (bisa >24 jam), bukan jam dinding.
    // ------------------------------------------------------------
    if (
      /^\d{1,3}:\d{2}$/.test(valueStr) &&
      /^(jam|hour|hours|h)$/i.test(unitStr)
    ) {      
      return {
        pass: true,
        status: 'SUSPECT',
        rule: 'VALUE',
        reason:
          'Durasi jam-menit merupakan nilai majemuk; gunakan attribute_value',
        severity: 'MEDIUM'
      };
    }

    // ------------------------------------------------------------
    // N17: Range value langsung di field value — "40-55", "40–55",
    // "30–45" dengan unit fps/mp/hz/dst. Padanan N1 di atomicity.ts
    // (yang sudah lebih dulu mengenali range sebagai SATU nilai di
    // level klaim), tapi ValueValidator belum punya versinya.
    //
    // "gb"/"mb" SENGAJA TIDAK dimasukkan ke whitelist unit di bawah.
    // Beda dengan fps/hz/mp/nits/watt/mah yang secara natural memang
    // bisa berupa rentang (frame rate naik-turun, refresh rate
    // dinamis), kapasitas storage/RAM HAMPIR TIDAK PERNAH benar-benar
    // rentang. Value seperti "8-256" + unit "gb" jauh lebih mungkin
    // representasi keliru dari DUA SPEK BERBEDA (RAM 8GB + storage
    // 256GB) yang seharusnya ditolak sama seperti varian slash-nya
    // ("8/256" + unit "gb" -- lihat blok compound value FAIL di bawah),
    // bukan rentang asli.
    // ------------------------------------------------------------
    // PERLUASAN: daftar unit putih (fps|mp|hz|nits|watt|mah) melewatkan
    // rentang berunit lain yang sama sahnya -- "40-50 cm" (jarak),
    // "30-35 %" (volume). Dibalik menjadi daftar HITAM: rentang
    // diterima untuk satuan apa pun KECUALI kapasitas penyimpanan
    // (gb/mb/tb). Selaras dengan RANGE_RE di atomicity.ts.
    if (
      /^\d+(?:[.,]\d+)?\s*[–-]\s*\d+(?:[.,]\d+)?$/.test(valueStr) &&
      unitStr !== '' &&
      !/^(gb|mb|tb)$/i.test(unitStr)
    ) {      
      return {
        pass: true,
        status: 'SUSPECT',
        rule: 'VALUE',
        reason:
          'Rentang numerik harus direpresentasikan melalui attribute_value, bukan value/unit',
        severity: 'MEDIUM'
      };
    }

    // ------------------------------------------------------------
    // N18: Durasi format "N jam M" (unit di luar: "menit"). Varian
    // KETIGA dari bug durasi majemuk (setelah N16 "17:42"+jam).
    // Dikonfirmasi run11 Q016: "1 jam 28" + unit "menit" dari klaim
    // "1 jam 28 menit". CATATAN: ini tambalan REAKTIF, bukan solusi
    // akar. Pola compound-descriptor di value/unit terus bermutasi
    // notasi (N9→N12→N15→N16→N17→N18). Prompt v6.0 memuat instruksi
    // eksplisit agar compound → attribute_value.
    // ------------------------------------------------------------
    if (
      /^\d{1,2}\s*jam\s*\d{1,2}$/i.test(valueStr) &&
      /^(menit|minute|minutes|m)$/i.test(unitStr)
    ) {      
      return {
        pass: true,
        status: 'SUSPECT',
        rule: 'VALUE',
        reason:
          'Durasi jam-menit merupakan nilai majemuk; gunakan attribute_value',
        severity: 'MEDIUM'
      };
    }

    // ------------------------------------------------------------
    // Rule 1: value non-numerik + unit terisi → SUSPECT HIGH
    // ------------------------------------------------------------
    if (unitStr && !isNumeric(valueStr) && !valueStr.includes('/')) {
      return {
        pass: false,
        status: 'SUSPECT',
        rule: 'VALUE',
        reason: `Value non-numerik "${valueStr}" tidak kompatibel dengan unit "${unitStr}"`,
        severity: 'HIGH'
      };
    }

    // Compatibility: rentang numerik tanpa satuan tetap PASS.
    // Rentang dengan satuan tetap ditangani oleh N17 sebagai SUSPECT MEDIUM.
    if (
      /^\d+(?:[.,]\d+)?\s*[–-]\s*\d+(?:[.,]\d+)?$/.test(valueStr) &&
      !unitStr
    ) {
      return {
        pass: true,
        status: 'PASS',
        rule: 'VALUE',
        severity: 'LOW'
      };
    }

    // ------------------------------------------------------------
    // NEW RULE A: Non-numeric orphan value (value non-numerik + unit null)
    // ------------------------------------------------------------
    // Menutup gap: "value='Gorilla Glass Victus', unit=null" sebelumnya
    // lolos tanpa penanda apa pun. Prompt rule 7 menginstruksikan nilai
    // kategorik masuk ke attribute_value, bukan value.
    //
    // Pengecualian: value null/kosong (tidak ada yang dicek).
    // Pengecualian: value yang match whitelist compound di atas sudah
    //   return lebih dulu, jadi tidak sampai ke sini.
    //
    // Severity MEDIUM karena tidak selalu salah -- ada nilai kategorik
    // yang memang belum punya attribute_value eksplisit tapi bukan
    // representasi yang diharapkan. Ini sinyal untuk normalisasi.
    // ------------------------------------------------------------
    if (!unitStr && valueStr !== '' && !isNumeric(valueStr) && !valueStr.includes('/')) {
      return {
        pass: true,
        status: 'SUSPECT',
        rule: 'VALUE',
        reason: `Value non-numerik "${valueStr}" tanpa unit; prompt rule 7 menghendaki nilai kategorik di attribute_value, bukan value`,
        severity: 'MEDIUM'
      };
    }

    // ------------------------------------------------------------
    // NEW RULE B: Unit di luar whitelist
    // ------------------------------------------------------------
    // Menutup gap: unit tidak pernah dicek terhadap daftar sah.
    // Prompt rule 7 mendefinisikan daftar unit yang diizinkan.
    //
    // Hanya trigger kalau unitStr non-kosong. Unit kosong sudah
    // ditangani Rule 1 / New Rule A.
    //
    // Severity HIGH karena unit di luar whitelist kemungkinan besar
    // salah ketik, singkatan non-standar, atau satuan tidak didukung.
    // ------------------------------------------------------------
    if (unitStr && !UNIT_WHITELIST.has(unitStr.toLowerCase())) {
      return {
        pass: true,
        status: 'SUSPECT',
        rule: 'VALUE',
        reason: `Unit "${unitStr}" tidak ada di whitelist prompt rule 7`,
        severity: 'HIGH'
      };
    }

    // ------------------------------------------------------------
    // Compound value: "8/256" (blok lama)
    // ------------------------------------------------------------
    if (valueStr.includes('/')) {
      const parts = valueStr.split('/');
      if (parts.length === 2) {
        const isNumericCompound =
          isNumeric(parts[0].trim()) && isNumeric(parts[1].trim());

        if (isNumericCompound) {
          const knownValidFractions = [
            { value: '1/30', units: ['detik', 's', 'second'] },
            { value: '1/60', units: ['detik', 's', 'second'] }
          ];

          const isKnownValid = knownValidFractions.some(f =>
            f.value === valueStr &&
            f.units.some(u => unitStr.toLowerCase() === u)
          );

          if (isKnownValid) {
            return { pass: true, status: 'PASS', rule: 'VALUE', severity: 'LOW' };
          }

          // Compound storage value: "8/256 GB", "4/64 MB", "1/2 TB"
          // Semua kombinasi RAM/Storage compound, bukan fraction yang sah.
          if (unitStr && /^(gb|mb|tb)$/i.test(unitStr)) {
            return {
              pass: false,
              status: 'FAIL',
              rule: 'VALUE',
              reason: `Compound value terdeteksi: ${valueStr} ${unitStr}`,
              severity: 'HIGH'
            };
          }

          return {
            pass: true,
            status: 'SUSPECT',
            rule: 'VALUE',
            reason: `Numeric ratio yang belum dikenal: ${valueStr}`,
            severity: 'MEDIUM'
          };
        }
      }
    }

    return { pass: true, status: 'PASS', rule: 'VALUE', severity: 'LOW' };
  }
};

// Desimal Indonesia memakai koma ("1,5 jam"); format titik juga diterima.
// Sebelumnya hanya titik, sehingga "1,5" + "jam" dikarantina sebagai non-numerik.
function isNumeric(str: string): boolean {
  return /^-?\d+([.,]\d+)?$/.test(str);
}
