// CHANGELOG v3 -> v4:
//   - Downgrade comma-list 3+ item dari SUSPECT HIGH ke SUSPECT MEDIUM.
//     Rationale: enumeration semantik (proper nouns, kategori, features)
//     adalah SATU fakta, bukan compound faktual. Model mengekstrak
//     dengan tepat sebagai list; split menghasilkan explosion of
//     low-value evidence tanpa informasi tambahan.
//
//     Contoh affected: "2G, 3G, 4G, 5G" (networks), "PIN, password,
//     pattern" (security), "selfie, utama, ultrawide" (cameras).
//
//     TETAP HIGH (tidak di-downgrade):
//     - multi-value + unit ("8 GB dan 256 GB", 2 distinct specs)
//     - "dan" + 2 numerik ("Full HD+ 2340x1080p dan refresh rate 120Hz")
//
//     Flag ATOMICITY tetap muncul di accepted_flagged untuk audit.
//     Downstream yang butuh atomic murni bisa filter by flag.
// ============================================================
// ATOMICITY VALIDATOR — v3
// ============================================================
// CHANGELOG v2 -> v3:
//   - FIX kontradiksi internal: rangeValuePattern tidak lagi
//     memuat gb|mb. Sebelumnya "8-256 GB" lolos di sini tapi
//     FAIL HIGH di value.ts N17 → status kontradiktif antar
//     validator. Sekarang konsisten: gb/mb bukan range.
//   - TAMBAH konjungsi yang hilang: serta, plus, kemudian, &, +
//     (dengan guard terhadap pasangan pecahan "1/30 + 1/60").
//     Prompt rule 2 menyebut semua ini sebagai pemicu split.
//   - NAIKKAN cluster fitur tanpa angka dari MEDIUM ke HIGH:
//     comma-list 3+ item (2+ koma) sekarang HIGH terlepas dari
//     ada tidaknya angka. Selaras dengan prompt PRINSIP 3
//     (Edge Panel, Object Eraser, Knox Vault, dst).
//   - TAMBAH whitelist adjective pair: "X dan Y" yang keduanya
//     kata sifat kualitatif → PASS (satu observasi, bukan dua).
//     Prompt rule 2 contoh: "videonya stabil dan minim jitter".
//   - PERLUAS commaList3PlusPattern: terima plus|kemudian.
// ============================================================
// Perubahan dari v1 ke v2 (dipertahankan):
//   - Severity dibedakan berdasarkan BUKTI compound:
//     * SUSPECT HIGH  → compound genuine (multi-value beda unit, atau
//                        comma-list + angka/unit, atau " dan " + angka)
//     * SUSPECT MEDIUM → indikasi compound ringan (comma-list tanpa angka,
//                        " dan " tanpa angka)
//     * PASS          → komparatif tunggal ("lebih tebal dibanding A, B, C")
//                        atau alternatif penulisan ("1080p atau Full HD")
// ============================================================

import type { ValidationResult } from '../types';

// Rentang non-dash ("30 hingga 45 fps", "40 sampai ke 50 cm", "3 hingga 4 juta").
// Rentang gb/mb SENGAJA tidak dibuang (selaras value.ts N17): "8 hingga 256 GB"
// lebih mungkin dua spek berbeda daripada rentang sungguhan.
// Hardening: satuan boleh muncul setelah angka PERTAMA juga ("30 fps hingga 45 fps",
// "30 fps - 45 fps"); versi awal hanya mengenali satuan setelah angka kedua.

const RANGE_UNITS =
  'fps|mp|ghz|mhz|khz|hz|nits|watt|mah|cm|mm|juta|ribu|derajat(?:\\s+celsius)?|jam|menit|detik|kali|tahun|%';


const RANGE_RE = new RegExp(
  `\\b\\d+(?:[.,]\\d+)?(?:\\s*(?:${RANGE_UNITS}))?\\s*(?:[–-]|hingga|sampai(?:\\s+ke)?|s\\/d)\\s*` +
  `\\d+(?:[.,]\\d+)?\\b(?!\\s*(?:gb|mb)\\b)(?:\\s*(?:${RANGE_UNITS}))?`,
  'gi'
);

// ------------------------------------------------------------
// Kata sifat kualitatif yang mendeskripsikan SATU observasi.
// Dipakai untuk whitelist "X dan Y" (dua kata sifat → satu observasi).
// Prompt rule 2: "videonya stabil dan minim jitter" → SATU evidence.
// Daftar ini bisa diperluas tanpa mengubah logika utama.
// ------------------------------------------------------------
const QUALITY_ADJECTIVES =
  'stabil|halus|konsisten|jernih|tajam|mulus|rapi|bersih|empuk|presisi|' +
  'minim|kencang|cepat|lancar|baik|bagus|terang|lembut|kuat|kokoh|' +
  'jelas|nyaman|aman|awet|responsif|senyap';
const ADJECTIVE_PAIR_RE = new RegExp(
  `\\b(${QUALITY_ADJECTIVES})\\b\\s+dan\\s+\\b(${QUALITY_ADJECTIVES})\\b`,
  'i'
);

export const AtomicityValidator = {
  validate(claim: string | undefined): ValidationResult {
    const normalizedClaim = (claim || '').toLowerCase();

    // ------------------------------------------------------------
    // 1. WHITELIST — klaim atomic yang sah memakai konjungsi
    // ------------------------------------------------------------

    // Komparatif tunggal: "X lebih [sifat] dibanding A, B, dan C"
    // atau "X lebih [sifat] dari A dan B"
    const comparativePattern =
      /\blebih\s+\w+\s+(dibanding|dari|daripada)\b/i;
    
    // ------------------------------------------------------------
    // COMPARATIVE EXCEPTION (ORDER-INDEPENDENT)
    // Dua objek pembanding + satu metrik + satu hasil persentase
    // merupakan satu proposisi komparatif, bukan compound.
    //
    // Angka pada nama produk/model (A37, A27) bukan nilai metrik.
    // Urutan unsur dalam klaim tidak harus tetap.
    // ------------------------------------------------------------

    const metricMatches =
      normalizedClaim.match(/\b(?:single[- ]core|multi[- ]core)\b/gi) || [];

    const hasSingleMetric = metricMatches.length === 1;
    const hasAntara = /\bantara\b/i.test(normalizedClaim);
    const hasDan = /\bdan\b/i.test(normalizedClaim);
    const hasBeda = /\b(?:beda|berbeda|selisih)\b/i.test(normalizedClaim);

    // Jangan menggunakan \b setelah simbol % karena % bukan
    // karakter word. Boundary hanya diperlukan pada "persen".
    const comparisonResultCount = (
      normalizedClaim.match(/\b\d+(?:[.,]\d+)?\s*(?:%|\bpersen\b)/gi) || []
    ).length;

    const comparisonDanCount = (
      normalizedClaim.match(/\bdan\b/gi) || []
    ).length;

    if (
      hasSingleMetric &&
      hasAntara &&
      hasDan &&
      hasBeda &&
      comparisonResultCount === 1 &&
      comparisonDanCount === 1
    ) {
      return {
        pass: true,
        status: 'PASS',
        rule: 'ATOMICITY',
        severity: 'LOW'
      };
    }



    // Alternatif penulisan: "1080p atau Full HD", "60Hz atau 120Hz"
    // Hanya dianggap alternatif bila tidak ada 'dan' (yang menandakan
    // listing). Pemicu ' atau ' tanpa ' dan ' biasanya cuma sinonim
    // atau nilai yang sama dengan penulisan berbeda.
    const hasAlternativeAtau = /\s+atau\s+/i.test(normalizedClaim);

    // ------------------------------------------------------------
    // NORMALISASI POLA ATOMIC
    // Pola yang merupakan satu kesatuan semantik dinormalisasi,
    // bukan dijadikan alasan untuk langsung PASS seluruh klaim.
    // ------------------------------------------------------------

    // N3: Setup protocol pengujian.
    // FPS + durasi pengujian dihitung sebagai SATU unit protokol.
    // Jika ada fakta tambahan di luar protokol, fakta itu tetap
    // diperiksa oleh deteksi compound di bawah.
    const setupProtocolPattern =
      /\b\d+\s*fps\b[^.!?]*?\b(selama|durasi|dimainkan)\b[^.!?]*?\b\d+\s*(menit|jam)\b/i;

    const claimWithProtocolCollapsed = normalizedClaim.replace(
      setupProtocolPattern,
      ' 1 protokol '
    );

    // N12b: Pasangan adjective kualitatif untuk satu observasi.
    // "stabil dan minim jitter" menjadi satu unit observasi.
    // Konjungsi lain di luar pasangan tersebut tetap dipertahankan.
    let claimForAtomicity = claimWithProtocolCollapsed.replace(
      ADJECTIVE_PAIR_RE,
      'observasi'
    );

    // ------------------------------------------------------------
    // NORMALISASI FRAGMEN ATOMIC — bukan early return.
    // Fragmen yang dikenali diganti placeholder agar fakta lain
    // di luar fragmen tetap diperiksa oleh deteksi compound.
    // ------------------------------------------------------------
    let hasNormalizedAtomicFragment = false;

    const normalizeAtomicFragment = (pattern: RegExp) => {
      const nextClaim = claimForAtomicity.replace(pattern, ' fakta_atomic ');
      if (nextClaim !== claimForAtomicity) {
        hasNormalizedAtomicFragment = true;
        claimForAtomicity = nextClaim;
      }
    };

    
    // P1: RAM + penyimpanan hanya dinormalisasi sebagai konfigurasi
    // varian jika konteks varian dinyatakan secara eksplisit.
    // Konfigurasi generik tetap dianggap compound.
    // Konteks harus melekat langsung pada fragmen RAM/storage yang
    // dinormalisasi. Kata "varian/opsi" yang hanya menerangkan warna
    // atau atribut lain tidak boleh mengaktifkan P1.
    const hasLocalVariantContext = (
      text: string,
      match: RegExpMatchArray
    ): boolean => {
      const matchIndex = match.index ?? 0;
      const prefix = text.slice(Math.max(0, matchIndex - 64), matchIndex);

      const networkQualifier =
        String.raw`(?:\s+(?:wi-?fi(?:\s+only)?|lte|[345]g))*`;

      const directVariantPrefix = new RegExp(
        String.raw`\b(?:(?:tersedia\s+dalam\s+)?varian|opsi)${networkQualifier}\s*$`,
        'i'
      );

      const directAvailabilityPrefix = new RegExp(
        String.raw`\bhadir\s+dengan(?:\s+varian)?${networkQualifier}\s*$`,
        'i'
      );

      return (
        directVariantPrefix.test(prefix) ||
        directAvailabilityPrefix.test(prefix)
      );
    };

    // Flag khusus P1. Jangan memakai hasNormalizedAtomicFragment untuk
    // pengecualian harga karena flag tersebut juga diaktifkan oleh N2-N14.
    let hasNormalizedVariantConfig = false;

    // Salinan klaim untuk pemeriksaan fakta independen pada price claim.
    // Salinan ini hanya akan menghapus konfigurasi varian P1, bukan
    // fragmen lain yang dinormalisasi oleh aturan atomic lainnya.
    let claimForVariantPriceCheck = normalizedClaim;

    
    const variantConfigPatterns: RegExp[] = [
      // RAM -> label penyimpanan:
      // "varian RAM 8 GB dan ROM 128 GB"
      // "RAM 8 GB memiliki internal 128 GB"
      /\bram\s+\d+(?:[.,]\d+)?\s*gb\b(?:\s+(?:(?:memiliki|dan|serta|dengan|tersedia|dalam|varian|kapasitas|sebesar|yaitu|adalah|untuk|dibekali|dilengkapi))){0,8}\s+\b(?:rom|storage|penyimpan(?:an)?(?:\s+internal)?|memori(?:\s+internal)?|internal(?:\s+penyimpanan)?)\s+\d+(?:[.,]\d+)?\s*gb\b/i,

      // Label penyimpanan -> RAM:
      // "varian penyimpanan 128 GB dibekali RAM 6 GB"
      // "varian ROM 128 GB dan RAM 8 GB"
      /\b(?:rom|storage|penyimpan(?:an)?(?:\s+internal)?|memori(?:\s+internal)?|internal(?:\s+penyimpanan)?)\s+\d+(?:[.,]\d+)?\s*gb\b(?:\s+(?:(?:memiliki|dan|serta|dengan|tersedia|dalam|varian|kapasitas|sebesar|yaitu|adalah|untuk|dibekali|dilengkapi))){0,8}\s+\bram\s+\d+(?:[.,]\d+)?\s*gb\b/i,

      // Varian RAM dengan notasi slash:
      // "varian RAM 4 GB / 64 GB"
      /\bram\s+\d+(?:[.,]\d+)?\s*gb\s*\/\s*\d+(?:[.,]\d+)?\s*gb\b/i,

      // Varian kapasitas tanpa label penyimpanan:
      // "varian 128 GB memiliki RAM 8 GB"
      // "varian 256 GB dibekali RAM 8 GB"
      /\b\d+(?:[.,]\d+)?\s*gb\b(?:\s+(?:(?:memiliki|dan|serta|dengan|tersedia|dalam|varian|kapasitas|sebesar|yaitu|adalah|untuk|dibekali|dilengkapi))){0,8}\s+\bram\s+\d+(?:[.,]\d+)?\s*gb\b/i,

      // Notasi ringkas:
      // "varian 4 GB / 64 GB"
      /\b\d+(?:[.,]\d+)?\s*gb\s*\/\s*\d+(?:[.,]\d+)?\s*gb\b/i
    ];

    for (const pattern of variantConfigPatterns) {
      // Cari fragmen pada klaim yang belum dinormalisasi agar posisi
      // konteks lokal dapat diuji terhadap teks asli.
      const match = normalizedClaim.match(pattern);
      if (!match || !hasLocalVariantContext(normalizedClaim, match)) {
        continue;
      }

      const nextClaim = claimForAtomicity.replace(
        pattern,
        ' fakta_atomic '
      );

      if (nextClaim !== claimForAtomicity) {
        hasNormalizedVariantConfig = true;
        hasNormalizedAtomicFragment = true;
        claimForAtomicity = nextClaim;

        // Hapus hanya konfigurasi varian dari salinan pemeriksaan harga.
        claimForVariantPriceCheck = claimForVariantPriceCheck.replace(
          pattern,
          ' fakta_atomic '
        );
      }
    }


    // P2: satu metrik yang berubah dari nilai lama menjadi nilai baru.
    normalizeAtomicFragment(
      /\b(?:resolusi(?:\s+kamera)?|kapasitas\s+baterai|harga(?:\s+promo)?)\b[^.!?]{0,60}?\b(?:berubah|meningkat|menurun|turun|naik|bertambah|berkurang)\b[^.!?]{0,40}?\bdari\s+(?:rp\s*)?\d+(?:[.,]\d+)?\s*(?:mp|mah|gb|mb|hz|fps|watt|%|persen)?\s+menjadi\s+(?:rp\s*)?\d+(?:[.,]\d+)?\s*(?:mp|mah|gb|mb|hz|fps|watt|%|persen)?/i
    );

    // N2: durasi jam-menit adalah satu nilai komposit.
    normalizeAtomicFragment(
      /\b\d+\s*jam(?:\s+lebih)?\s+\d+\s*menit\b/i
    );

    // N4: shutter speed + frame rate dalam satu mode video.
    normalizeAtomicFragment(
      /\b1\/\d+\s*detik\b[^.!?]*?\bvideo\s+\d+\s*fps\b/i
    );

    // N5: satu protokol battery test; mendukung % maupun "persen".
    normalizeAtomicFragment(
      /(?:\b\d+\s*(?:%|persen)\b[^.!?]*?\b(?:mode|refresh rate)\b[^.!?]*?\b\d+\s*(?:menit|jam)\b|\b(?:mode|refresh rate)\b[^.!?]*?\b\d+\s*(?:menit|jam)\b[^.!?]*?\b\d+\s*(?:%|persen)\b)/i
    );

    // N12: resolusi + fps + evaluasi kualitatif sebagai satu observasi.
    normalizeAtomicFragment(
      /\b(?:4k|8k|2k|\d{3,4}p)\b[^.!?]*?\b\d+\s*fps\b[^.!?]*?\b(stabil|minim|terjaga|konsisten|mulus|halus|jernih|tajam)\b/i
    );

    // N13: kapasitas baterai + durasi daya tahan sebagai satu klaim.
    normalizeAtomicFragment(
      /\b\d{4}\s*mah\b[^.!?]*?\b\d+\s*(?:jam|menit)\b/i
    );

    // N14: pilihan kategorik, bukan dua nilai hasil pengukuran.
    normalizeAtomicFragment(
      /\b(pilih|pilihan|opsi|memilih|pilihlah)\b[^.!?]*?\b\d+\s*(?:atau|\/)\s*\d+\b/i
    );

    // Pasangan pecahan seperti "1/30 + 1/60" bukan konjungsi compound.
    const fractionPairPattern = /\b\d+\/\d+\s*[+&]\s*\d+\/\d+\b/g;

    // FIX false-positive: "Plus" pada nama model ("A11 Plus") terdeteksi
    // sebagai konjungsi, dan "5G"/"A11" terhitung sebagai nilai numerik.
    // Strip pola tersebut sebelum mendeteksi konjungsi dan angka.
    const claimForConjunction = claimForAtomicity
      .replace(fractionPairPattern, ' ')
      .replace(/\b[a-z]*\d+\s+plus\b/gi, ' [model_plus] ')   // "A11 Plus", "Note 20 Plus"
      .replace(/\b\d+g\b/gi, ' [network_generation] ')        // "5G", "4G"
      .replace(/\blte\b/gi, ' [network_lte] ')                // "LTE"
      .replace(/\bwi-?fi(?:\s+only)?\b/gi, ' [wifi_variant] ') // "Wi-Fi Only"
      .replace(
        /\b(?:snapdragon|exynos|dimensity|helio)\s+[a-z]?\d+(?:\s+gen\s+\d+)?\b/gi,
        ' [chipset_model] '
      );

    const hasConjunctionDan =
      /\s+(dan|serta|plus|kemudian)\s+/i.test(claimForConjunction) ||
      /\s[&+]\s/.test(claimForConjunction);

    // Angka model dan label jaringan tidak boleh dihitung sebagai
    // nilai numerik dalam pemeriksaan compound berbasis konjungsi.
    // RANGE_RE di-strip juga agar rentang tidak dihitung dua kali.
    const claimForConjunctionNumberCount =
      claimForConjunction.replace(RANGE_RE, ' ');

    // ------------------------------------------------------------
    // 2b. WHITELIST PATTERN — klaim atomic yang sering salah ditandai
    //     compound. Dikonfirmasi dari audit 4-run transkrip lab-style.
    // ------------------------------------------------------------

    // N3b: "setting/mode X dan frame rate <apa pun> ..." = kondisi uji,
    // bukan nilai kedua.
    const configThenMeasurePattern =
      /\b(?:setting|settingan|pengaturan|mode|preset)\b(?:(?!\bdan\b)[^.!?])*?\bdan\b\s+(?:frame rate|fps|refresh rate)\s+\w+\b/i;
    const claimMinusConfig = normalizedClaim.replace(configThenMeasurePattern, ' ');
    if (
      configThenMeasurePattern.test(normalizedClaim) &&
      !/\s+dan\s+/i.test(claimMinusConfig) &&
      !/,[^,]{1,80},/.test(claimMinusConfig)
    ) {
      return { pass: true, status: 'PASS', rule: 'ATOMICITY', severity: 'LOW' };
    }

    // Rentang dihitung SATU nilai: buang sebelum mendeteksi multi-value.
    // Patch 3: Gunakan klaim hasil normalisasi untuk pemeriksaan range
    const claimNoRange = claimForAtomicity.replace(RANGE_RE, ' rentang ');
    const rangeCount = (claimForAtomicity.match(RANGE_RE) ?? []).length;

    // ------------------------------------------------------------
    // 2. BUKTI COMPOUND KUAT
    // ------------------------------------------------------------

    // Multi-value dengan unit (bisa unit sama atau beda):
    // "8 GB dan 256 GB", "1 meter selama 30 menit"
    // Patch 4: Menambahkan satuan derajat Celsius dan unit protokol
    const multiValuePattern =
      /\b\d+(?:[.,]\d+)?\s*(meter|menit|jam|detik|mm|nm|gb|mb|kali|tahun|fps|mp|ghz|mhz|khz|watt|mah|hz|derajat(?:\s+celsius)?|protokol)\b[^.!?]*?\b\d+(?:[.,]\d+)?\s*(meter|menit|jam|detik|mm|nm|gb|mb|kali|tahun|fps|mp|ghz|mhz|khz|watt|mah|hz|derajat(?:\s+celsius)?|protokol)\b/i;

    // Comma-list 3+ item dengan "dan/serta/plus/kemudian" di akhir.
    // Contoh: "dual mic, speaker, dan USB Type-C"
    //      atau "mic, speaker, plus USB Type-C"
    const commaList3PlusPattern =
      /,[^,]{1,80},\s*(dan|serta|plus|kemudian)\b/i;

    const hasMultiValue = multiValuePattern.test(claimNoRange);
    const hasCommaList3Plus = commaList3PlusPattern.test(claimNoRange);

    // ============================================================
    // PRICE CLAIM EXCEPTION — Identitas varian bukan proposisi tambahan
    // ============================================================
    // Dalam konstruksi "Harga [varian X] adalah Rp Y", RAM dan storage
    // di [varian X] berfungsi sebagai identitas subjek, bukan proposisi
    // konfigurasi terpisah. Config sudah di-claim di evidence lain.
    const isPriceClaim =
      /\b(?:harga|dibanderol|seharga|berharga)\b/i.test(claimNoRange) &&
      /\brp\.?\s*\d/i.test(claimNoRange);

    
    if (hasNormalizedVariantConfig && isPriceClaim) {
      // Hapus nominal harga dan konfigurasi varian dari klaim asli.
      // Jangan gunakan claimNoRange di sini karena fragmen lain seperti
      // durasi jam-menit mungkin sudah dinormalisasi oleh N2.
      const claimWithoutPrice = claimForVariantPriceCheck
        .replace(
          /\brp\.?\s*\d+(?:[.,]\d{3})*(?:[.,]\d+)?/gi,
          ' '
        );

      // Fakta ukur independen di luar identitas konfigurasi varian
      // tetap membuat klaim menjadi compound HIGH.
      const hasOtherMeasuredFact =
        /\b\d+(?:[.,]\d+)?\s*(?:meter|menit|jam|detik|mm|nm|gb|mb|tb|mah|mp|fps|ghz|mhz|khz|hz|watt|nits|inci|cm|derajat(?:\s+celsius)?|%|persen)\b/i.test(
          claimWithoutPrice
        );

      if (hasOtherMeasuredFact) {
        return {
          pass: false,
          status: 'SUSPECT',
          rule: 'ATOMICITY',
          reason:
            'Price claim memuat fakta pengukuran independen di luar identitas varian',
          severity: 'HIGH'
        };
      }

      return {
        pass: true,
        status: 'SUSPECT',
        rule: 'ATOMICITY',
        reason:
          'Price claim dengan identifikasi varian — satu proposisi harga',
        severity: 'MEDIUM'
      };
    }


    // ============================================================
    // Fakta ukur independen di luar fragmen atomic tetap HIGH.
    // ============================================================
    const hasMeasuredFactOutsideNormalizedFragment =
      hasNormalizedAtomicFragment &&
      (
        (
          hasConjunctionDan &&
          /\b\d+(?:[.,]\d+)?\s*(?:meter|menit|jam|detik|mm|nm|gb|mb|kali|tahun|fps|mp|ghz|mhz|khz|watt|mah|hz|derajat(?:\s+celsius)?|ribu|juta|%)\b/i.test(claimNoRange)
        ) ||
        /\brp\.?\s*\d[\d.,]*/i.test(claimNoRange)
      );

    if (hasMeasuredFactOutsideNormalizedFragment) {
      return {
        pass: false,
        status: 'SUSPECT',
        rule: 'ATOMICITY',
        reason: 'Fakta pengukuran independen berada di luar fragmen atomic yang dikenali',
        severity: 'HIGH'
      };
    }

    // Hitung koma untuk membedakan:
    //   0 koma   → bukan comma-list
    //   1 koma   → "X, Y" (2 item) → MEDIUM (borderline)
    //   2+ koma  → 3+ item       → HIGH (compound genuine)
    const commaCount = (claimNoRange.match(/,/g) || []).length;

    // ------------------------------------------------------------
    // 3. WHITELIST RETURN — klaim atomic yang sah
    // ------------------------------------------------------------

    // Komparatif tunggal, asal tidak ada multi-value tersembunyi
    if (comparativePattern.test(normalizedClaim) && !hasMultiValue) {
      return {
        pass: true,
        status: 'PASS',
        rule: 'ATOMICITY',
        severity: 'LOW'
      };
    }

    // Alternatif " atau " tanpa ' dan ' dan tanpa multi-value
    if (
      hasAlternativeAtau &&
      !hasConjunctionDan &&
      !hasMultiValue &&
      commaCount === 0
    ) {
      return {
        pass: true,
        status: 'PASS',
        rule: 'ATOMICITY',
        severity: 'LOW'
      };
    }

    // Multi-value + " atau " tanpa " dan " → kemungkinan alternatif penulisan
    if (hasMultiValue && hasAlternativeAtau && !hasConjunctionDan) {
      return {
        pass: true,
        status: 'SUSPECT',
        rule: 'ATOMICITY',
        reason: 'Multi-value dihubungkan dengan "atau" — kemungkinan alternatif penulisan nilai yang sama',
        severity: 'MEDIUM'
      };
    }

    // ------------------------------------------------------------
    // 4. COMPOUND KUAT → SUSPECT HIGH (quarantine)
    // ------------------------------------------------------------

    // Multi-value dengan unit → compound genuine
    if (hasMultiValue) {
      return {
        pass: false,
        status: 'SUSPECT',
        rule: 'ATOMICITY',
        reason:
          'Multi-value dengan satuan terdeteksi — dua nilai berbeda dalam satu klaim',
        severity: 'HIGH'
      };
    }

    // Patch 5: Bedakan daftar dampak dari enumeration fitur
    const hasOutcomeList3Plus =
      hasCommaList3Plus &&
      /\b(penurunan|peningkatan|kenaikan|penambahan|pengurangan|penyusutan|menurun|meningkat|berkurang|bertambah|memburuk|membaik)\b/i.test(
        claimNoRange
      );

    if (hasOutcomeList3Plus) {
      return {
        pass: false,
        status: 'SUSPECT',
        rule: 'ATOMICITY',
        reason:
          'Daftar tiga atau lebih dampak/hasil pengamatan independen dalam satu klaim',
        severity: 'HIGH'
      };
    }

    // ============================================================
    // Enumeration / comma-list — SUSPECT MEDIUM, bukan quarantine.
    // ============================================================
    if (hasCommaList3Plus || commaCount >= 2) {
      const hasNumberOrUnit =
        /\b\d+(?:[.,]\d+)?\s*(meter|menit|jam|detik|mm|nm|gb|mb|kali|tahun|fps|mp|ghz|mhz|khz|watt|mah|hz|ribu|juta|%)\b/i.test(
          claimNoRange
        ) || /\b\d+\b/.test(claimNoRange) || rangeCount > 0;

      return {
        pass: true,
        status: 'SUSPECT',
        rule: 'ATOMICITY',
        reason: hasNumberOrUnit
          ? 'Comma-list 3+ item dengan nilai numerik — enumeration (bukan compound faktual)'
          : 'Comma-list 3+ item — enumeration (bukan compound faktual)',
        severity: 'MEDIUM'
      };
    }

    // ' dan ' + minimal 2 nilai numerik dengan satuan → compound kuat
    const compoundDescriptorPattern = /\b(?:4k|8k|2k|\d{3,4}p)\s+\d+\s*fps\b/gi;
    const claimWithoutCompoundDescriptors = claimNoRange.replace(
      compoundDescriptorPattern,
      ''
    );

    if (hasConjunctionDan) {
      const hasNumberOrUnitForConj =
        /\b\d+(?:[.,]\d+)?\s*(meter|menit|jam|detik|mm|nm|gb|mb|kali|tahun|fps|mp|ghz|mhz|khz|watt|mah|hz|ribu|juta|%)\b/i.test(
          claimWithoutCompoundDescriptors
        ) || /\b\d+\b/.test(claimWithoutCompoundDescriptors) || rangeCount > 0;

      if (hasNumberOrUnitForConj) {
        // N04: Identitas chipset + satu fakta spesifikasi independen
        // merupakan dua fakta berbeda, meskipun hanya ada satu angka
        // pengukuran setelah angka model chipset dinormalisasi.
        const hasChipsetIdentity =
          /\b(?:snapdragon|exynos|dimensity|helio)\s+[a-z]?\d+(?:\s+gen\s+\d+)?\b/i.test(
            claimForAtomicity
          );

        const hasIndependentMeasuredValue =
          /\b\d+(?:[.,]\d+)?\s*(?:meter|menit|jam|detik|mm|nm|gb|mb|kali|tahun|fps|mp|ghz|mhz|khz|watt|mah|hz|derajat\s+celsius|ribu|juta|%)\b/i.test(
            claimWithoutCompoundDescriptors
          ) ||
          /\b\d+(?:[.,]\d+)?\s*°\s*c\b/i.test(
            claimWithoutCompoundDescriptors
          );

         if (hasChipsetIdentity && hasIndependentMeasuredValue) {
           return {
             pass: false,
             status: 'SUSPECT',
             rule: 'ATOMICITY',
             reason:
              'Identitas chipset dan fakta spesifikasi terukur merupakan dua fakta independen',
             severity: 'HIGH'
          };
        }
        const numberMatches =
          claimForConjunctionNumberCount
            .replace(compoundDescriptorPattern, '')
            .match(/\b\d+(?:[.,]\d+)?/g) || [];
        if (numberMatches.length + rangeCount >= 2) {
          return {
            pass: false,
            status: 'SUSPECT',
            rule: 'ATOMICITY',
            reason:
              'Dua nilai numerik atau lebih dihubungkan dengan "dan" — compound spesifikasi',
            severity: 'HIGH'
          };
        }
      }
    }

    // ------------------------------------------------------------
    // 5. COMPOUND RINGAN → SUSPECT MEDIUM (tidak quarantine)
    // ------------------------------------------------------------

    if (commaCount === 1) {
      return {
        pass: true,
        status: 'SUSPECT',
        rule: 'ATOMICITY',
        reason: 'Comma-list 2 item, perlu review manual',
        severity: 'MEDIUM'
      };
    }

    if (hasConjunctionDan) {
      return {
        pass: true,
        status: 'SUSPECT',
        rule: 'ATOMICITY',
        reason: 'Indikasi compound ringan, perlu review manual',
        severity: 'MEDIUM'
      };
    }

    // Klausa adversatif: dua kondisi/penilaian yang dikontraskan.
    // Contoh: "suara bisa keras tetapi pada volume tinggi mengalami distorsi".
    // Ditandai MEDIUM (bukan HIGH), karena kontras kualitatif saja belum
    // membuktikan adanya dua nilai ukur yang harus dikarantina.
    // Konstruksi korektif "bukan X tetapi Y" dikecualikan agar tidak
    // otomatis dianggap sebagai dua evidence.
    const hasAdversativeConjunction =
      /\b(?:tetapi|namun|akan tetapi|sedangkan)\b/i.test(normalizedClaim);
    const isCorrectiveContrast =
      /\b(?:bukan|tidak hanya|tak hanya)\b[^.!?]*\b(?:tetapi|namun|melainkan)\b/i.test(normalizedClaim);

    if (hasAdversativeConjunction && !isCorrectiveContrast) {
      return {
        pass: true,
        status: 'SUSPECT',
        rule: 'ATOMICITY',
        reason: 'Klausa kontras/adversatif memuat lebih dari satu kondisi atau penilaian; perlu review manual',
        severity: 'MEDIUM'
      };
    }

    return {
      pass: true,
      status: 'PASS',
      rule: 'ATOMICITY',
      severity: 'LOW'
    };
  }
};
