import { describe, test, expect } from 'vitest';
import { AtomicityValidator } from '../atomicity';

const V = AtomicityValidator.validate;
const blocks = (c: string) => {
  const r = V(c);
  return r.status === 'SUSPECT' && r.severity === 'HIGH';
};

// ============================================================
// BAGIAN 1 — test asli (tidak diubah)
// ============================================================
describe('ATOMICITY VALIDATOR', () => {
  test('PASS: single proposition', () => {
    expect(V('Refresh rate 120Hz').status).toBe('PASS');
  });
  test('PASS: configurative compound', () => {
    expect(V('Samsung Knox lengkap dengan Knox Vault').status).toBe('PASS');
  });
  test('PASS: camera configuration', () => {
    expect(V('kamera 50 MP f/1.8 autofocus').status).toBe('PASS');
  });
  test('SUSPECT: multi-property', () => {
    expect(V('RAM 8 GB dan storage 256 GB').status).toBe('SUSPECT');
  });
  test('SUSPECT: two independent facts', () => {
    expect(V('NFC dan USB OTG').status).toBe('SUSPECT');
  });
});

// ============================================================
// BAGIAN 2 — severity (aturan inti: HIGH memblokir, MEDIUM hanya menandai)
// ============================================================
describe('ATOMICITY VALIDATOR: severity', () => {
  test('HIGH: dua properti berlabel dengan angka', () => {
    expect(blocks('RAM 8 GB dan storage 256 GB')).toBe(true);
  });
  test('HIGH: tiga spesifikasi dalam comma-list', () => {
    expect(blocks('RAM 8 GB, storage 256 GB, dan baterai 5000 mAh')).toBe(true);
  });
  test('MEDIUM (tidak memblokir): daftar fitur tanpa angka', () => {
    const r = V('NFC dan USB OTG');
    expect(r.severity).toBe('MEDIUM');
    expect(r.pass).toBe(true);
  });
  test('MEDIUM: "atau" untuk multi-value = alternatif penulisan', () => {
    const r = V('Kamera utama dapat merekam video hingga resolusi 4K 30fps atau Full HD 60fps');
    expect(r.severity).toBe('MEDIUM');
  });
});

// ============================================================
// BAGIAN 3 — rentang dihitung SATU nilai (data nyata, 15 video)
// ============================================================
describe('ATOMICITY VALIDATOR: rentang = satu nilai', () => {
  test.each([
    ['Frame rate Wuthering Waves setelah 10 menit mengalami penurunan di kisaran 30 hingga 45 fps'],
    ['Frame rate Genshin Impact pada 10 menit terakhir saat menggunakan kipas berada di sekitar 30 hingga 40 fps'],
    ['Pada rentang harga 3 hingga 4 juta, HP Infinix atau Poco dinilai menawarkan spesifikasi yang lebih menggiurkan dan ugal-ugalan'],
    ['Jarak antara handphone dan muka saat perekaman kamera depan adalah sekitar 40 sampai ke 50 cm'],
    ['Frame rate 30–45 fps pada game berat']
  ])('tidak memblokir: %s', claim => {
    expect(blocks(claim)).toBe(false);
  });
  test('satuan di antara rentang: "30 fps hingga 45 fps"', () => {
    expect(blocks('Frame rate berada di 30 fps hingga 45 fps pada game berat')).toBe(false);
    expect(blocks('Frame rate 30 fps - 45 fps')).toBe(false);
  });
  test('rentang GB/MB SENGAJA bukan rentang (lebih mungkin dua spek)', () => {
    expect(blocks('Penyimpanan 8 hingga 256 GB dan RAM 8 GB')).toBe(true);
  });
  test('rentang + spesifikasi lain tetap compound', () => {
    expect(blocks('Frame rate 30 hingga 45 fps dan baterai 5000 mAh')).toBe(true);
  });
});

// ============================================================
// BAGIAN 4 — "setting X dan frame rate Y" = kondisi uji (N3b)
// ============================================================
describe('ATOMICITY VALIDATOR: konfigurasi uji + satu nilai ukur', () => {
  test.each([
    ['Frame rate rata-rata Mobile Legends pada setting Ultra dan frame rate Super adalah 88,4 fps'],
    ['Frame rate rata-rata PUBG Mobile pada setting Smooth dan frame rate Extreme adalah 59 fps'],
    ['Frame rate rata-rata Call of Duty Mobile pada setting low dan frame rate max adalah 59,8 fps'],
    ['Frame rate rata-rata Free Fire pada setting ultra dan frame rate high adalah 59,4 fps'],
    ['Frame rate rata-rata game Hauka pada setting ultra dan frame rate ultra adalah 92,8 fps'],
    ['Frame rate rata-rata FC Mobile pada setting high dan frame rate high adalah 60 fps'],
    ['Frame rate rata-rata Genshin Impact pada setting lowest dan frame rate 60 adalah 49 fps']
  ])('PASS bersih: %s', claim => {
    expect(V(claim).status).toBe('PASS');
  });
  test('compound lain di klaim yang sama tetap tertangkap (" dan suhu ...")', () => {
    expect(blocks('Performa pada setting Ultra dan frame rate Super adalah 50 fps dan suhu 38 derajat')).toBe(true);
  });
  test('fragmen konfigurasi tidak boleh menelan " dan " lain', () => {
    expect(blocks('Performa pada setting Ultra dan suhu 38 derajat dan frame rate Super adalah 50 fps')).toBe(true);
  });
  test('comma-list tersisa di luar fragmen konfigurasi tetap tertangkap', () => {
    expect(blocks('Pada setting Ultra dan frame rate Super hasilnya 50 fps, baterai 5000 mAh, layar 6,7 inci')).toBe(true);
  });
});

// ============================================================
// BAGIAN 5 — karakterisasi 9 karantina ATOMICITY yang tersisa (replay 15 video)
// ============================================================
// Penilaian manual (satu penilai). Yang sah tetap memblokir; yang salah
// ditandai test.fails: jika kelak aturan diperbaiki, test.fails melaporkan
// kegagalan dan tes dipindah ke bagian "tidak memblokir".
describe('ATOMICITY VALIDATOR: karantina tersisa, yang sah', () => {
  test('performa + suhu + protokol uji dalam satu klaim (compound sungguhan)', () => {
    expect(blocks('Performa gaming PUBG Mobile pada Galaxy A26 sangat lancar dan stabil dengan suhu maksimal 37 derajat Celsius pada settingan smooth extreme selama 30 menit')).toBe(true);
  });
  test('versi Android dan versi One UI (dua fakta)', () => {
    expect(blocks('Samsung Galaxy A26 mendapatkan jaminan update hingga Android 21 dan One UI versi 13')).toBe(true);
  });
});

// Empat klaim di bawah ini DIBLOKIR oleh aturan saat ini. Apakah itu benar atau
// false positive adalah KEPUTUSAN KEBIJAKAN yang masih terbuka (predikat bersama /
// daftar nilai numerik: satu proposisi atau beberapa?). Test ini mengunci perilaku
// SAAT INI agar perubahan kebijakan terlihat sebagai perubahan test, bukan kejutan.
// Jika kebijakan diputuskan "MEDIUM saja", ubah ekspektasi menjadi false.
describe('ATOMICITY VALIDATOR: perilaku saat ini, kebijakan terbuka', () => {
  test.each([
    'Reviewer menilai daya tahan baterai 25 jam pada 60 Hz sangat memuaskan',
    'Lensa ultrawide tidak tersedia pada perekaman video 4K 30 fps dan Full HD 60 fps',
    'Kamera utama dapat merekam video hingga resolusi 4K 30fps dan Full HD 60fps',
    'Video 1080p 60 fps mengalami penurunan detail, peningkatan noise, dan tampilan lebih gelap'
  ])('HIGH (saat ini): %s', c => {
    expect(V(c).severity).toBe('HIGH');
  });
  // Catatan konsistensi: dua efek ("penurunan detail dan noise") = MEDIUM, tiga efek = HIGH
  // karena angka "1080p 60 fps" ikut terhitung; "atau" = MEDIUM, "dan" = HIGH.
  test('konsistensi: "atau" MEDIUM vs "dan" HIGH pada daftar mode yang sama', () => {
    expect(V('Lensa ultrawide tidak tersedia pada video 4K 30 fps atau Full HD 60 fps').severity).toBe('MEDIUM');
  });
});

// ============================================================
// BAGIAN 6 — test dari implementasi pengguna (dipertahankan)
// ============================================================
describe('ATOMICITY VALIDATOR: rentang tanpa blokir (kasus pengguna)', () => {
  test.each([
    'Pada rentang harga 3 hingga 4 juta, HP Infinix atau Poco dinilai menawarkan spesifikasi yang lebih menggiurkan dan ugal-ugalan',
    'Jarak antara handphone dan muka saat perekaman kamera depan adalah sekitar 40 sampai ke 50 cm'
  ])('MEDIUM (diterima + flag): %s', c => {
    const r = V(c);
    expect(r.status).toBe('SUSPECT');
    expect(r.severity).toBe('MEDIUM');
  });
  // Klaim asli memuat typo "30hingga" (tanpa spasi); sengaja dipertahankan.
  test.each([
    'Frame rate Wuthering Waves setelah 10 menit mengalami penurunan di kisaran 30hingga 45 fps',
    'Frame rate Genshin Impact pada 10 menit terakhir saat menggunakan kipas berada di sekitar 30 hingga 40 fps',
    'Frame rate rata-rata Genshin Impact pada setting lowest dan frame rate 60 adalah 49 fps'
  ])('PASS bersih: %s', c => expect(V(c).status).toBe('PASS'));
  test.each([
    'Frame rate rata-rata Mobile Legends pada setting Ultra dan frame rate Super adalah 88,4 fps',
    'Frame rate rata-rata Free Fire pada setting ultra dan frame rate high adalah 59,4 fps',
    'Frame rate rata-rata FC Mobile pada setting high dan frame rate high adalah 60 fps'
  ])('PASS bersih (preset, bukan angka): %s', c => expect(V(c).status).toBe('PASS'));
  test('guard: config + "dan suhu" tetap HIGH', () => {
    expect(V('Frame rate rata-rata PUBG pada setting smooth dan frame rate extreme adalah 59 fps dan suhu 38 derajat Celsius').severity).toBe('HIGH');
  });
  test('guard: bukan konfigurasi tetap HIGH', () => {
    expect(V('Refresh rate 120 Hz dan frame rate 60 fps').severity).toBe('HIGH');
  });
  test.each([
    'Kecerahan layar 400 sampai 800 nits dan refresh rate 120 Hz',
    'Refresh rate 60 hingga 120 Hz dan baterai 5000 mAh',
    'Harga 3 hingga 4 juta dan RAM 8 GB',
    'RAM 8 hingga 256 GB tersedia dan storage 128 GB'
  ])('guard rentang: tetap HIGH: %s', c => expect(V(c).severity).toBe('HIGH'));
  test('Android + One UI: dua fakta, HIGH', () => {
    expect(V('Samsung Galaxy A26 mendapatkan jaminan update hingga Android 21 dan One UI versi 13').severity).toBe('HIGH');
  });
});

describe('ATOMICITY VALIDATOR: celah recall (compound kualitatif tidak ditandai)', () => {
  test('polaritas campuran dengan "tetapi" seharusnya ditandai', () => {
    expect(V('Suara speaker bisa keras tetapi pada volume tinggi mengalami distorsi').status).toBe('SUSPECT');
  });
});


// ============================================================
// BAGIAN 7 — upgrade semantik: konfigurasi dan perubahan nilai
// ============================================================
// Tes-tes ini sengaja TIDAK mengubah ekspektasi historis di bagian 1–6.
// test.fails menandai gap implementasi saat ini: ketika validator sudah
// memahami relasi semantik dengan benar, test.fails harus diubah menjadi
// test biasa dan dipindahkan ke kelompok PASS yang sesuai.

describe('ATOMICITY VALIDATOR: konfigurasi produk = satu kesatuan semantik', () => {
  test.each([
    'Samsung Galaxy A07s varian RAM 4 GB memiliki internal 64 GB',
    'Samsung Galaxy A18 tersedia dalam varian RAM 8 GB dan penyimpanan 128 GB',
    'Samsung Galaxy A37 5G hadir dengan RAM 8 GB dan internal penyimpanan 256 GB',
  ])('tidak memblokir konfigurasi satu varian: %s', claim => {
    expect(blocks(claim)).toBe(false);
  });

  test('tetap HIGH jika dua spesifikasi independen, bukan satu konfigurasi varian', () => {
    expect(blocks('Refresh rate 120 Hz dan frame rate 60 fps')).toBe(true);
    expect(blocks('Baterai turun 7 persen dan suhu mencapai 41 derajat Celsius')).toBe(true);
  });

  test('tetap HIGH untuk tiga hasil pengamatan independen', () => {
    expect(blocks('Video 1080p 60 fps mengalami penurunan detail, peningkatan noise, dan tampilan lebih gelap')).toBe(true);
  });
});

describe('ATOMICITY VALIDATOR: satu metrik berubah dari nilai lama ke nilai baru', () => {
  test('harga lama ke harga baru tidak diblokir sebagai compound', () => {
    expect(blocks('Harga promo turun dari Rp2.799.000 menjadi Rp2.699.000')).toBe(false);
  });

  test.each([
    'Resolusi kamera berubah dari 8 MP menjadi 5 MP',
    'Kapasitas baterai meningkat dari 4500 mAh menjadi 5000 mAh',
  ])('satu perubahan nilai tidak diblokir sebagai compound: %s', claim => {
    expect(blocks(claim)).toBe(false);
  });

  test('dua perubahan metrik independen dalam satu klaim tetap HIGH', () => {
    expect(blocks('Resolusi kamera berubah dari 8 MP menjadi 5 MP dan baterai meningkat dari 4500 mAh menjadi 5000 mAh')).toBe(true);
  });
});

// ============================================================
// BAGIAN 8 — upgrade guard: whitelist tidak boleh menelan fakta lain
// ============================================================
// Saat ini beberapa whitelist melakukan return PASS secara langsung.
// Tes berikut mendefinisikan perilaku yang lebih aman: pola whitelist boleh
// menormalkan bagian yang dikenal, tetapi fakta independen di luar pola
// tetap harus diperiksa.

describe('ATOMICITY VALIDATOR: whitelist tidak menelan compound tambahan', () => {
  test('battery test + suhu tetap terdeteksi sebagai compound', () => {
    expect(blocks('Baterai turun 7 persen pada mode 120 Hz selama 30 menit dan suhu mencapai 41 derajat Celsius')).toBe(true);
  });

  test.each([
    'Daya tahan baterai mencapai 17 jam 42 menit dan suhu maksimum 41 derajat Celsius',
    'Shutter speed 1/60 detik untuk video 60 fps dan suhu mencapai 38 derajat Celsius',
    'Baterai 5000 mAh tahan hingga 25 jam dan suhu mencapai 41 derajat Celsius',
    'Pada resolusi 4K 30 fps video terlihat stabil dan suhu mencapai 41 derajat Celsius',
  ])('fakta independen di luar whitelist tetap terdeteksi: %s', claim => {
    expect(blocks(claim)).toBe(true);
  });

  test('whitelist murni tetap diterima', () => {
    expect(V('Daya tahan baterai mencapai 17 jam 42 menit').status).toBe('PASS');
    expect(V('Shutter speed 1/60 detik untuk video 60 fps').status).toBe('PASS');
    expect(V('Baterai 5000 mAh tahan hingga 25 jam').status).toBe('PASS');
    expect(V('Pada resolusi 4K 30 fps video terlihat stabil dan minim jitter').status).toBe('PASS');
  });
});

// ============================================================
// BAGIAN 9 — relasi numerik tidak boleh dilonggarkan secara global
// ============================================================

describe('ATOMICITY VALIDATOR: guard agar deteksi compound tetap presisi', () => {
  test('dua nilai bersatuan dengan metrik berbeda tetap HIGH', () => {
    expect(blocks('Refresh rate 120 Hz dan konsumsi daya 5 watt')).toBe(true);
    expect(blocks('Kecerahan 800 nits dan baterai 5000 mAh')).toBe(true);
  });

  test('dua hasil pengukuran independen tetap HIGH meski satuan sama', () => {
    expect(blocks('Suhu prosesor 41 derajat Celsius dan suhu bodi 38 derajat Celsius')).toBe(true);
  });

  test('rentang satu metrik + metrik independen tetap HIGH', () => {
    expect(blocks('Frame rate 30 hingga 45 fps dan baterai 5000 mAh')).toBe(true);
    expect(blocks('Kecerahan 400 sampai 800 nits dan refresh rate 120 Hz')).toBe(true);
  });
});

describe('ATOMICITY: nama model dan label jaringan bukan konjungsi', () => {
  test.each([
    'Samsung Galaxy Tab A11 Plus varian 5G dilengkapi RAM 6 GB',
    'Samsung Galaxy Tab A11 Plus varian 5G dilengkapi memori internal 128 GB',
    'Galaxy S21 Plus dilengkapi baterai 5000 mAh',
    'iPhone 15 Plus dengan RAM 8 GB',
    'Samsung Galaxy Tab A11 Plus varian Wi-Fi Only RAM 6 GB'
  ])('tidak HIGH karena nama model/jaringan: %s', (claim) => {
    const result = AtomicityValidator.validate(claim);
    expect(result.severity).not.toBe('HIGH');
  });

  test('compound sejati tetap HIGH: RAM 8 GB dan storage 256 GB', () => {
    const result = AtomicityValidator.validate('RAM 8 GB dan storage 256 GB');
    expect(result.severity).toBe('HIGH');
  });

  test('compound sejati tetap HIGH: Baterai 5000 mAh dan suhu 41 derajat', () => {
    const result = AtomicityValidator.validate(
      'Baterai 5000 mAh dan suhu 41 derajat'
    );
    expect(result.severity).toBe('HIGH');
  });

  test('c2#8: price claim dengan identitas varian → MEDIUM', () => {
    const result = V(
      'Samsung Galaxy Tab A11 Plus varian Wi-Fi Only RAM 6GB internal 128GB dibanderol dengan harga Rp 4.499.000'
    );

    expect(result.pass).toBe(true);
    expect(result.status).toBe('SUSPECT');
    expect(result.severity).toBe('MEDIUM');
    expect(result.reason).toMatch(/proposisi harga/i);
  });

  test('c2#12: price claim dengan identitas varian → MEDIUM', () => {
    const result = V(
      'Samsung Galaxy Tab A11 Plus varian 5G RAM 6GB internal 128GB dibanderol dengan harga Rp 5.999.000'
    );

    expect(result.pass).toBe(true);
    expect(result.status).toBe('SUSPECT');
    expect(result.severity).toBe('MEDIUM');
  });

    test.each([
      'Harga Samsung Galaxy Tab A11 varian Wi-Fi Only 4 GB / 64 GB adalah Rp 2.699.000',
      'Harga Samsung Galaxy Tab A11 varian LTE 4 GB / 64 GB adalah Rp 3.499.000'
    ])('price claim dengan slash notation → MEDIUM: %s', claim => {
      const result = V(claim);
      expect(result.pass).toBe(true);
      expect(result.severity).toBe('MEDIUM');
    });

    test('price claim + fakta baterai independen tetap HIGH', () => {
      const result = V(
        'Harga varian RAM 4 GB / 64 GB adalah Rp 2.199.000 dan baterai 5000 mAh'
      );
      expect(result.severity).toBe('HIGH');
    });

    test('konfigurasi generik tanpa konteks varian tetap HIGH', () => {
      const result = V('RAM 8 GB dan storage 256 GB');
      expect(result.severity).toBe('HIGH');
    });

  test('konfigurasi RAM dan storage tanpa harga tetap diterima', () => {
    const result = AtomicityValidator.validate(
      'Samsung Galaxy A18 tersedia dalam varian RAM 8 GB dan penyimpanan 128 GB'
    );

    expect(result.severity).not.toBe('HIGH');
  });

  test.each([
    'Samsung Galaxy Tab A11 Plus varian Wi-Fi Only RAM 6GB internal 128GB dibanderol dengan harga Rp 4.499.000',
    'Samsung Galaxy Tab A11 Plus varian 5G RAM 6GB internal 128GB dibanderol dengan harga Rp 5.999.000'
  ])('price claim dengan identitas konfigurasi varian → MEDIUM: %s', (claim) => {
    const result = AtomicityValidator.validate(claim);

    expect(result.pass).toBe(true);
    expect(result.status).toBe('SUSPECT');
    expect(result.severity).toBe('MEDIUM');
  });
});