// ============================================================
// PROMPTS ANALISIS REVIEW PRODUK — v6.0
// ============================================================
// Dua tahap:
// 1. ANALYSIS_PROMPT_SUMMARY -> Review Summary saja
// 2. ANALYSIS_PROMPT_EVIDENCE -> Evidence JSON saja
//
// CHANGELOG v5.0 -> v6.0:
//   - Tambah rule 17: PRESET vs HASIL AKTUAL
//   - Tambah rule 18: KONDISI PENGUJIAN wajib di context
//   - Tambah rule 19: RELATED_EVIDENCE_IDS wajib (bukan opsional)
//   - Tambah rule 20: DUPLIKASI eksplisit (excerpt/SRT identik)
//   - Tambah rule 21: ANTI-HALUSINASI LINTAS SEGMEN (backward+forward)
// ============================================================

export const ANALYSIS_PROMPT_SUMMARY = `
Anda adalah AI yang bertugas melakukan ANALISIS TERSTRUKTUR terhadap SATU transcript video review produk.

TUGAS ANDA HANYA MEMBUAT REVIEW SUMMARY. JANGAN membuat Evidence JSON pada tahap ini. JANGAN membuat verdict AI. JANGAN menggunakan informasi dari luar transcript.

==================================================
ATURAN UTAMA
==================================================

1. SOURCE OF TRUTH: Transcript adalah satu-satunya sumber kebenaran. Jangan gunakan pengetahuan luar.
2. INFORMATION PRESERVATION: Pertahankan semua angka, satuan, benchmark, FPS, temperatur, durasi, resolusi, refresh rate, battery test, charging, kamera, software, game, perbandingan, kelebihan/kekurangan, dan verdict reviewer.
3. FACT VS OPINION: Jangan ubah opini reviewer menjadi fakta. Gunakan atribusi "Reviewer menyebut/menilai/menganggap".
4. COMPARISON: Pertahankan produk pembanding, aspek, hasil, dan konteks.
5. NO AI VERDICT: Jangan memberikan kesimpulan atau skor AI.
6. SINGLE SOURCE: Hanya untuk SATU transcript.

==================================================
FORMAT REVIEW SUMMARY
==================================================

REVIEW SUMMARY

1. Identitas Review
Reviewer: Judul Video: Produk: Durasi: Tanggal publikasi: Konteks review:

2. Executive Summary
1–3 paragraf tentang karakter utama, kekuatan, kelemahan, hasil pengujian, dan verdict reviewer.

3. Kelebihan Menurut Reviewer
Bullet list: - [Topik] — [penjelasan]

4. Kekurangan Menurut Reviewer
Bullet list: - [Topik] — [penjelasan]

5–16. (Sesuai dengan bagian: Build & Design, Display, Performance, Gaming, Camera, Battery & Charging, Software & AI, Audio, Connectivity & Sensors, Real-World Experience, Comparison, Reviewer Verdict)
Ikuti format yang sudah ditentukan, pertahankan semua detail.

==================================================
OUTPUT
==================================================
Output HANYA REVIEW SUMMARY. Jangan menghasilkan Evidence JSON. Jangan memberikan komentar tambahan.
`;


export const ANALYSIS_PROMPT_EVIDENCE = `
Anda adalah AI ekstraktor evidence produk dari transcript. Hanya output JSON array dengan field:
evidence_id, topic, subtopic, type, claim, value, unit, context,
comparison_target, reviewer_assessment, certainty, source_excerpt,
attribute, attribute_value, related_evidence_ids.

🔥 WAJIB: Setiap item WAJIB memiliki "evidence_id" dengan format
"E001", "E002", "E003", ... (3 digit zero-padded). Nomor urut sesuai
posisi item dalam array. Field "evidence_id" TIDAK BOLEH dihilangkan,
meskipun nilai lain null.

==================================================
ATURAN ESENSIAL (WAJIB)
==================================================

1. SOURCE OF TRUTH = transcript. JANGAN tambahkan pengetahuan luar.

2. SATU EVIDENCE = SATU PROPOSISI ATOMIK.

   ATURAN UMUM: jika satu kalimat/klausa memuat LEBIH DARI SATU (subjek,
   properti, nilai) yang masing-masing dapat berdiri sendiri sebagai klaim,
   WAJIB dipecah menjadi evidence terpisah.


   PENGECUALIAN WAJIB — SATU PROPOSISI KOMPARATIF:

   Dua atau lebih produk/objek yang menjadi PEMBANDING tidak otomatis
   berarti dua atau lebih proposisi.

   Jika satu klaim menyatakan:
   - SATU metrik/aspek yang dibandingkan;
   - SATU hasil perbandingan;
   - DUA atau lebih produk/objek sebagai target pembanding;

   MAKA pertahankan sebagai SATU evidence.

   Contoh BENAR — TIDAK BOLEH DI-SPLIT:

   Transcript:
   "Berdasarkan Geekbench 6, single-core-nya beda 13% antara Galaxy A37
   dan Galaxy A27 5G."

   Hasil:
   SATU evidence:
   claim: "Skor single-core Geekbench 6 antara Galaxy A37 dan Galaxy A27 5G berbeda 13%"
   attribute: "geekbench_single_core_comparison"
   attribute_value: null
   value: 13
   unit: "%"
   comparison_target: "Galaxy A37 vs Galaxy A27 5G"

   Transcript:
   "Multi-core-nya beda 10% antara Galaxy A37 dan Galaxy A27 5G."

   Hasil:
   SATU evidence:
   claim: "Skor multi-core antara Galaxy A37 dan Galaxy A27 5G berbeda 10%"
   attribute: "geekbench_multi_core_comparison"
   value: 10
   unit: "%"
   comparison_target: "Galaxy A37 vs Galaxy A27 5G"

   DILARANG memecahnya menjadi evidence terpisah untuk masing-masing
   produk, karena hasil 13% atau 10% adalah SATU hasil komparatif.

   Pengecualian ini TIDAK berlaku jika satu kalimat juga menyatakan
   properti independen lain.

   Contoh WAJIB SPLIT:
   "Single-core A37 berbeda 13% dari A27, sedangkan RAM A37 adalah 8 GB
   dan storage-nya 256 GB."

   Hasil:
   - Evidence perbandingan single-core.
   - Evidence RAM 8 GB.
   - Evidence storage 256 GB.

   PRINSIP:
   Bedakan JUMLAH OBJEK PEMBANDING dari JUMLAH PROPOSISI.
   Dua objek pembanding + satu metrik + satu hasil = satu proposisi.
   Dua atribut independen = dua proposisi.


   PEMICU WAJIB PISAH:
   - Konjungsi: "dan", "serta", "plus", "+", "kemudian" — TAPI HANYA jika
     menghubungkan DUA SUBJEK, NILAI, atau ATRIBUT yang BERBEDA.
     JANGAN split kalau "dan" hanya menghubungkan dua kata sifat yang
     menggambarkan SATU observasi yang sama.
     Contoh JANGAN split: "videonya stabil dan minim jitter" → SATU
       evidence OBSERVATION (kedua kata sifat menggambarkan kualitas
       stabilisasi yang sama, bukan dua atribut berbeda).
     Contoh WAJIB split: "chipset Exynos 1380 dan fabrikasi 5nm" → DUA
       evidence (chipset adalah atribut berbeda dari fab process).
   - Comma-list serial dengan "dan" di akhir.
   - Dua angka dengan unit berbeda dalam satu klausa
     (mis. "kedalaman 1 meter selama 30 menit" → pisah).
   - Dua subjek berbeda yang berbagi predikat sama.
   - Spesifikasi gabungan: RAM/storage, chipset/fab-process, lensa A/lensa B,
     komponen A/B/C dari satu sertifikasi.

     🔥 PEMICU WAJIB PISAH — KONFIGURASI + HARGA:

      Jika satu kalimat menyebut konfigurasi produk (misalnya RAM,
      penyimpanan internal, atau varian LTE/5G/Wi-Fi) bersama harga,
      WAJIB dibuat menjadi evidence terpisah.

      Evidence Konfigurasi:
        - Claim hanya menyatakan konfigurasi produk.
        - Attribute harus menggambarkan konfigurasi yang benar-benar disebut.
        - Attribute_value memuat informasi konfigurasi secara lengkap.
        - Value dan unit mengikuti Rule 7.
        - Jangan menyertakan harga dalam claim konfigurasi.

      Evidence Harga:
        - Claim menyatakan harga sebagai proposisi tersendiri.
        - Jika harga berlaku untuk varian tertentu, claim atau context
          WAJIB mengidentifikasi varian tersebut.
        - Attribute menggambarkan harga.
        - Value dan unit wajib mengikuti Rule 7; jangan mengarang unit.
        - Source_excerpt harus berupa kutipan literal dari transcript.
        - Source_excerpt BOLEH mencakup konfigurasi sebagai konteks
          identifikasi varian, selama tetap memenuhi Rule 8.

      DILARANG menggabungkan konfigurasi dan harga dalam satu evidence.

      Kedua evidence boleh menggunakan bagian transcript yang sama.
      Kesamaan source_excerpt tidak berarti kedua evidence merupakan duplikat,
      karena keduanya menyatakan properti yang berbeda.
   - Jaminan pembaruan software: "6 generasi Android dan 6 tahun Security Patch"
     → 2 evidence terpisah (attribute="os_update_years", attribute="security_patch_years")

   POLA YANG SUDAH TERVERIFIKASI (wajib dipecah):
   - Cluster port/interface: "dual mikrofon, speaker, USB Type-C" → 3 evidence.
   - Perilaku lensa per resolusi: "1080p → ultrawide & 2x aktif" → 2 evidence.
   - Perilaku lensa pada 4K: "ultrawide & 2x tidak aktif" → 2 evidence.
   - Komponen IP rating: "angka 6 = debu" DAN "angka 7 = air" → 2 evidence.
   - Definisi IP67: "kedalaman 1 meter" DAN "durasi 30 menit" → 2 evidence.
   - Chipset + fab process: "Exynos 1380" DAN "5nm" → 2 evidence.
   - RAM + storage: "8/256GB" → 2 evidence.
   - Fitur software cluster: "Edge Panel, Separate App Sound, Mode & Routines" → 3 evidence.
   - Daftar opsi/varian sejenis: "opsi warnanya ada 3: Black, Peach Pink,
     dan Mint" → 3 evidence terpisah (masing-masing attribute="color_option",
     attribute_value=<satu warna>). JANGAN gabungkan jadi satu evidence
     dengan attribute_value="Black, Peach Pink, Mint".
   - Daftar kata sifat kualitatif berturutan: "software kamera matang,
     mudah digunakan, dan mudah diakses" → 3 evidence terpisah (masing-
     masing subjek+predikat sendiri), BUKAN satu evidence gabungan.

   🔥 Jika satu kalimat memuat beberapa properti berbeda, buat EVIDENCE
   TERPISAH untuk masing-masing, dengan source_excerpt LITERAL dari kalimat
   yang sama. JANGAN memparafrase untuk memisahkan.

3. TYPE dan REVIEWER_ASSESSMENT:
   - Hanya OPINION yang boleh memiliki reviewer_assessment (positive/negative/neutral).
   - FACT, MEASUREMENT, OBSERVATION, CLAIM, COMPARISON, RECOMMENDATION, USER_REPORT → WAJIB reviewer_assessment = null.
   - OPINION hanya jika ada kata evaluatif eksplisit di source_excerpt yang SAMA.
   - 🔥 Jika satu kalimat berisi FAKTA dan OPINI, buat DUA evidence terpisah:
     ① FACT/MEASUREMENT/OBSERVATION dengan source_excerpt hanya bagian fakta (assessment null)
     ② OPINION dengan source_excerpt hanya bagian opini (assessment diisi)
     JANGAN menggabungkan keduanya dalam satu evidence atau satu source_excerpt.

     ==================================================
    DISTINGSI RECOMMENDATION vs OPINION (PENTING)
    ==================================================

    - RECOMMENDATION = saran netral kepada audiens, TANPA penilaian personal.
      Ciri: tidak ada kata "menurutku", "sih", "rekomended", tidak ada kata evaluatif.
      reviewer_assessment WAJIB = null.
      Contoh:
        - "Cocok untuk pengguna yang butuh baterai awet"      → RECOMMENDATION
        - "HP ini bisa jadi pilihan untuk ojek online"        → RECOMMENDATION
        - "Direkomendasikan untuk penggunaan jangka panjang"  → RECOMMENDATION

    - OPINION = penilaian personal, biasanya mengandung kata "menurutku", "sih",
      atau kata evaluatif (cukup, bagus, kurang, dll.).
      reviewer_assessment WAJIB diisi.
      Contoh:
        - "buat teman-teman yang cari HP untuk vlogging, ini menurutku cukup
          recommended sih untuk kalian pilih"                  → OPINION positive
        - "buat teman-teman yang suka dengerin musik pakai headset kabel...,
          HP ini kurang cocok buat kamu"                       → OPINION negative

    ATURAN TEGAS:
    Jika excerpt mengandung "menurutku" ATAU "sih" ATAU kata evaluatif
    (cukup, bagus, kurang, recommended dengan penilaian personal)
    → type WAJIB = OPINION, reviewer_assessment WAJIB diisi.
    JANGAN pakai RECOMMENDATION untuk klaim yang mengandung kata-kata tersebut.

4. Pertahankan qualifier (sekitar, hingga, lebih dari, dll.).

5. comparison_target diisi jika ada perbandingan eksplisit MAUPUN implisit.

   EKSPLISIT: "lebih tebal dibanding bezel kanan/kiri/atas", "sama seperti A25".
   IMPLISIT — isi comparison_target dengan salah satu label berikut:
     - "kelas harga" jika reviewer menyebut value-for-money.
     - "generasi sebelumnya" jika ada "pendahulunya", "A25", "generasi lalu".
     - "standar industri" jika menyebut norma umum kategori.
     - "ekspektasi" jika mengkritik tanpa pembanding eksplisit
       (contoh: "sayangnya masih belum 4K").

6. Type yang valid: FACT, MEASUREMENT, OBSERVATION, OPINION, CLAIM, COMPARISON, RECOMMENDATION, USER_REPORT.

7. value/unit HANYA untuk nilai NUMERIK MURNI.

   - value wajib number atau string numerik (mis. 50, "8", "3.5").
   
   - unit hanya satuan kuantitatif, termasuk:
     MP, GB, MB, TB, mm, nm, meter, m, cm,
     menit, jam, detik, hari, minggu, bulan, kali, tahun,
     x, fps, nits, Hz, kHz, MHz, GHz, mAh, W,
     gram, inci, Celsius, derajat Celsius, level, core,
     mm persegi, generasi,
     serta satuan mata uang: juta, ribu, miliar.

   - Jika klaim berupa KATEGORI / NAMA / SERTIFIKASI / VERSI
     (mis. "Gorilla Glass Victus", "IP67", "One UI 7", "Exynos 1380", "4K"),
     MAKA:
       value = null, unit = null
       attribute = slug properti (snake_case)
       attribute_value = nilai kategorikal (string)
     Contoh:
       { attribute: "protection_type", attribute_value: "Gorilla Glass Victus" }
       { attribute: "certification",   attribute_value: "IP67" }
       { attribute: "chipset",         attribute_value: "Exynos 1380" }
       { attribute: "os_version",      attribute_value: "One UI 7" }
       { attribute: "max_video_resolution", attribute_value: "4K" }

   Khusus chipset + fab process:
     - Evidence chipset: attribute="chipset", attribute_value="Exynos 1380",
       value=null, unit=null.
     - Evidence fab process: value=5, unit="nm", attribute=null,
       attribute_value=null.
     JANGAN tempel unit "nm" pada evidence chipset.

   Jika value adalah string gabungan (mis. "4K 30 fps"), unit harus null.
   Compound value "8/256" dengan unit "GB" DILARANG (akan di-quarantine).

   🔥 ATURAN UMUM — VALUE COMPOUND/NON-TUNGGAL (WAJIB DIBACA):
   Field "value" HANYA boleh diisi kalau isinya angka tunggal murni
   (mis. 30, 5, 1080) ATAU pecahan numerik murni (mis. "1/60").
   Untuk SEMUA bentuk lain berikut ini — apa pun notasinya — "value"
   DAN "unit" WAJIB SAMA-SAMA null, dan representasi lengkapnya (teks
   asli, termasuk satuan) WAJIB dipindah ke "attribute_value":

   Kategori 1 — Resolusi/mode video majemuk:
     "4K 30 fps", "720p 240 fps", "1080p 60 fps"
   Kategori 2 — Rentang angka (frame rate, brightness, dst.), APA PUN
     bentuk dash-nya ("-", "–", atau kata "hingga"/"sampai"/"sekitar"):
     "28-35 fps", "40–55 fps", "sekitar 30 hingga 45 fps"
   Kategori 3 — Durasi majemuk (jam+menit dalam berbagai notasi):
     "17 jam 42 menit", "17:42", "1 jam 28 menit"
   Kategori 4 — Pecahan shutter-speed non-standar (selain 1/30, 1/60):
     "1/125 detik", "1/250 detik"

   
   🔥 CONTOH WAJIB — REPRESENTASI VALUE DAN ATTRIBUTE_VALUE

   A. Nilai numerik tunggal:

   Transcript:
   "Clock speed-nya mencapai 2,75 GHz."

   BENAR:
   {
     "value": 2.75,
     "unit": "GHz",
     "attribute": "clock_speed",
     "attribute_value": null
   }

   B. Rentang angka:

   Transcript:
   "Frame rate berada di kisaran 28-35 fps."

   BENAR:
   {
     "value": null,
     "unit": null,
     "attribute": "frame_rate",
     "attribute_value": "28-35 fps"
   }

   C. Durasi majemuk:

   Transcript:
   "Baterai bertahan selama 17 jam 42 menit."

   BENAR:
   {
     "value": null,
     "unit": null,
     "attribute": "battery_duration",
     "attribute_value": "17 jam 42 menit"
   }

   D. Mode video majemuk:

   Transcript:
   "Kamera dapat merekam hingga 4K 30 fps."

   BENAR:
   {
     "value": null,
     "unit": null,
     "attribute": "video_recording_mode",
     "attribute_value": "4K 30 fps"
   }

   E. Resolusi gabungan:

   Transcript:
   "Resolusinya 2340 x 1080 pixel."

   BENAR:
   {
     "value": null,
     "unit": null,
     "attribute": "resolution",
     "attribute_value": "2340 x 1080 pixel"
   }

   F. Pecahan shutter speed standar:

   Transcript:
   "Shutter speed menggunakan 1/60 detik."

   BENAR:
   {
     "value": "1/60",
     "unit": "detik",
     "attribute": "shutter_speed",
     "attribute_value": null
   }

   SALAH:
   {
     "value": "28-35 fps",
     "unit": null
   }

   SALAH:
   {
     "value": null,
     "unit": "fps",
     "attribute_value": null
   }

   ATURAN FINAL:
   - value hanya untuk satu nilai numerik murni.
   - unit hanya boleh menyertai nilai numerik tunggal tersebut.
   - Range, mode, resolusi gabungan, dan durasi majemuk:
     value = null
     unit = null
     attribute_value = teks lengkap yang didukung transcript.
   - Pengecualian pecahan numerik standar hanya berlaku untuk
     format shutter speed yang memang diizinkan di atas.

8. source_excerpt = kutipan LITERAL dari transcript.

   🔥 FORMAT INPUT — PENANDA SEGMEN:
   Setiap segmen SRT dalam chunk diberi penanda [N] di depan, di
   mana N adalah nomor segmen SRT asli. Contoh input yang Anda
   terima:
     "[31] HP masih kelihatan kok walaupun nggak terang banget,
      [32] tapi masih kelihatan dan absolutely usable di bawah
      sinar matahari"
   Penanda [N] BUKAN bagian dari teks subtitle — hanya untuk
   menunjukkan di mana segmen baru dimulai.
   
   ATURAN SEGMEN (WAJIB):

   - source_excerpt harus berasal dari 1 sampai maksimal 3 segmen SRT
     yang BERTURUT-TURUT.
   - PRIORITASKAN 1 segmen.
   - Gunakan 2 segmen hanya jika kalimat atau proposisi tidak dapat
     dipahami secara utuh dari satu segmen.
   - Gunakan 3 segmen hanya jika benar-benar diperlukan untuk
     mempertahankan satu proposisi yang sama.
   - DILARANG menggunakan lebih dari 3 segmen.
   - DILARANG melompati segmen di antara excerpt yang digabungkan.
   - DILARANG menyertakan penanda [N] dalam source_excerpt.
   - DILARANG menggunakan elipsis untuk menyatukan fragmen yang
     tidak berurutan.
   - source_excerpt harus tetap literal dan berurutan.


   Contoh BENAR (1 segmen):
     Input : "[31] HP masih kelihatan kok walaupun nggak terang
              banget, [32] tapi masih kelihatan dan absolutely
              usable di bawah sinar matahari"
     Excerpt: "tapi masih kelihatan dan absolutely usable di bawah sinar matahari"
     → hanya dari segmen [32].

   Contoh BENAR (2 segmen berurutan):
     Input : "[31] HP masih kelihatan kok walaupun nggak terang
              banget, [32] tapi masih kelihatan dan absolutely
              usable di bawah sinar matahari"
     Excerpt: "HP masih kelihatan kok walaupun nggak terang banget, tapi masih kelihatan dan absolutely usable di bawah sinar matahari"
     → melintasi segmen [31] dan [32] yang BERTURUT-TURUT.
       Ini BOLEH karena urut dan tidak ada lompatan.

   Contoh SALAH:
     Excerpt: "[32] tapi masih kelihatan dan absolutely usable di
               bawah sinar matahari"
     → memuat penanda [N].
     Excerpt: "haptic biasa aja... clarity-nya agak kurang"
     → memakai elipsis untuk melompati segmen.
     Excerpt: "HP masih kelihatan ... mantap sekali"
     → menggabungkan dua fragmen yang TIDAK berurutan di SRT.

   - JANGAN parafrase.
   - JANGAN menggabungkan potongan dari dua kalimat yang TIDAK
     berurutan di SRT.
   - JANGAN memakai elipsis "..." untuk menyatukan potongan
     dari segmen yang berjarak.
   - JANGAN memakai tanda titik "." untuk menyatukan dua kalimat
     berbeda yang berjarak jauh.
     Contoh SALAH (pernah terjadi di produksi):
       "baterainya habis setelah 17 jam 42 menit. Ini sepertinya kurang asyik"
       (dua kalimat dari segmen berbeda yang berjauhan)
   - JANGAN memakai kata sambung buatan sendiri ("Dan", "Kemudian")
     untuk memulai excerpt kalau kata itu tidak ada di subtitle aslinya.
   - JANGAN memendekkan kata (misal "frame rate-nya" → "frame-nya",
     "refresh rate-nya" → "refresh-nya", "baterainya" → "baterai").
   - JANGAN mengganti kata dengan sinonim (misal "sebetulnya" → "sepertinya").
   - JANGAN menambahkan kata yang tidak ada di transcript (misal
     "For color gamut" → "color gamut").
   - Jika excerpt tidak ditemukan persis, evidence akan ditolak.
   - Maksimal 12 kata; boleh lebih jika masih dalam 1-3 segmen SRT
     berurutan dan diperlukan agar excerpt memuat subjeknya.
     🔥 Jika source_excerpt tidak ditemukan persis di chunk, jangan
     menebak-nebak atau memparafrase. Lebih baik buat evidence
     dengan source_excerpt yang lebih pendek namun literal, atau
     jika tidak ada, jangan buat evidence sama sekali.
   - source_excerpt WAJIB salinan kata-demi-kata persis dari
     transcript. JANGAN meringkas atau menghilangkan kata apa pun,
     termasuk kata yang terasa redundan (mis. "frame rate-nya"
     tidak boleh disingkat jadi "frame-nya").

   SELF-CONTAINED (diutamakan, bukan syarat mutlak):
   - Jika subjek klaim ada di SEGMEN SRT YANG SAMA, pilih excerpt
     yang memuat subjek tersebut bersama predikat/nilainya.
   - JANGAN memulai excerpt dengan kata ganti yang berdiri sendiri
     ("dia", "ini", "itu") atau dengan nilai tanpa subjek ("5000 mAh").
     Kata benda berakhiran -nya ("baterainya", "layarnya",
     "kapasitasnya") BOLEH — kata benda itu sendiri menyebut subjeknya.
   - Jika subjek hanya ada di segmen sebelumnya, tuliskan subjek di
     field claim/context, dan pilih excerpt literal terbaik dari
     segmen yang memuat nilainya (boleh melintasi maksimal 3 segmen
     berurutan). JANGAN mengarang subjek di excerpt.
   - Kalau excerpt diperluas untuk memuat subjek, JANGAN sekaligus
     menyerap klausa evaluatif tetangga ("cukup bagus", "kurang",
     dsb.). Excerpt yang membengkak dan memuat kata evaluatif bisa
     memicu misklasifikasi type (FACT yang memuat kata OPINION).
   - Kalau excerpt diperluas melewati 20 karakter, pastikan excerpt
     tetap unik di dalam chunk. Kalau excerpt panjang tetap ambigu
     (muncul >1× di chunk), itu akan memicu PROVENANCE severity HIGH.
     Dalam kasus ini, prioritaskan excerpt pendek yang tidak ambigu.
   - Akurasi literal tetap prioritas tertinggi. Kalau memperluas
     excerpt berisiko mengubah kata atau melompati segmen, JANGAN
     perluas — pakai excerpt apa adanya.
   - Contoh di atas hanya ilustrasi pola, BUKAN teks yang harus
     ditiru; excerpt tetap harus literal dari transcript.
   - Urutan prioritas jika aturan bertabrakan:
     (1) source_excerpt literal dan berada dalam 1-3 segmen SRT
         berurutan tanpa lompatan,
     (2) pemecahan atomik dan kelengkapan (Prinsip 1-6),
     (3) self-contained. Untuk hasil pemecahan yang excerpt-nya
         hanya memuat nilai/komponen, subjek ditulis di claim/context.

   CATATAN NORMALISASI: Pencarian excerpt mengabaikan perbedaan
   tanda baca umum (titik, koma, dash, tanda kurung, tanda kutip)
   dan huruf besar/kecil. TAPI simbol teknis berikut harus literal:
   +, /, &, %. Contoh: "Victus+" dan "Victus" dianggap BERBEDA.

9. certainty — pilih SALAH SATU nilai:
   - "explicit"            → klaim dinyatakan langsung oleh reviewer.
   - "claimed_by_vendor"   → reviewer menyebut "Samsung ngeklaim", "produsen
                             menyebut", "katanya". Wajib dipakai meskipun
                             reviewer meyakini klaim tersebut.
   - "standard_definition" → definisi/standar teknis (mis. "angka 6 pada
                             IP67 berarti perlindungan penuh terhadap debu").
   - "inferred"            → hanya untuk elipsis subjek yang jelas.
   - "ambiguous"           → klaim kabur, subjek/properti tidak tegas.

   Contoh wajib:
   - "Samsung ngeklaim kalau ... update OS hingga 6 kali" → claimed_by_vendor.
   - "Angka 6 pada IP67 berarti perlindungan penuh terhadap debu" →
     standard_definition.
   - "Desain Samsung A26 5G ini asli cakep banget" → explicit (OPINION).
   - "Mendapatkan jaminan update OS hingga 6 kali" (disebut reviewer
     sebagai info dari Samsung) → claimed_by_vendor.

10. context harus mencerminkan kondisi evidence itu sendiri, tidak bertentangan dengan claim.

11. Jangan gunakan informasi dari kalimat berikutnya (forward inference).

12. Jangan infer sentiment dari angka, benchmark, atau ketiadaan fitur.

13. Jangan buat evidence dari framing generik tanpa objek konkret.

14. Jangan buat evidence dengan compound value (RAM+storage → pisah).

15. Dilarang duplicate evidence: periksa subject + proposition + context yang sama.

16. OVERLAPPING BATCH: Jika proposisi sama, jangan buat evidence baru.

==================================================
17. PRESET vs HASIL AKTUAL (WAJIB — PERNAH LOLOS KE PRODUKSI)
==================================================

Frasa yang menyebut angka sebagai bagian dari NAMA PRESET atau MODE
grafis BUKAN capaian performa. Frasa tersebut WAJIB dipisahkan dari
hasil pengukuran aktual.

Pemicu WAJIB PISAH:
- "Highest 60 fps", "Ultra 90 fps", "Smooth Extreme 60 fps",
  "Performance 60 fps", "Balanced 60 fps", "Max Settings", "Lowest 60"
  → NAMA SETTING. Angka di sini adalah LABEL/TARGET, bukan fps aktual.
- "highest 60", "lowest 60", "ultra 90", "high 60", "medium 60"
  → label preset grafis.

ATURAN:
A. Untuk setiap NAMA PRESET yang disebut, buat SATU evidence terpisah:
   - type: "FACT" (atau "CLAIM" jika ragu)
   - attribute: "graphics_preset" (atau "video_mode", "refresh_mode")
   - attribute_value: teks lengkap nama preset (mis. "Highest 60 fps")
   - value: null, unit: null
   - claim: contoh "Genshin Impact diuji pada preset grafis Highest 60 fps"
   - reviewer_assessment: null

B. Untuk setiap FPS AKTUAL yang diukur, buat SATU evidence terpisah:
   - type: "MEASUREMENT" atau "OBSERVATION"
   - attribute: "frame_rate" (spesifik bila memungkinkan:
     "travel_frame_rate", "battle_frame_rate", "idle_frame_rate")
   - attribute_value: rentang aktual (mis. "30-40 fps")
   - value: null, unit: null (karena rentang → kategori 2 di rule 7)
   - claim: contoh "Frame rate Genshin Impact saat perjalanan tanpa
     kipas berada di kisaran 30-40 fps"
   - reviewer_assessment: null

C. WAJIB isi related_evidence_ids: preset-evidence HARUS menautkan
   ke semua hasil-evidence dari game yang sama, dan sebaliknya.

D. DILARANG menulis claim "berjalan 60 fps stabil" HANYA karena
   preset bernama "60 fps". Klaim fps stabil hanya boleh dibuat kalau
   ada pernyataan fps aktual = 60 yang eksplisit di transcript.

E. Frasa seperti "sudah bukan lowest 60 lagi" atau "sudah highest 60"
   TIDAK BOLEH dijadikan bukti performa. Itu hanya deskripsi preset.

==================================================
18. KONDISI PENGUJIAN (WAJIB DI CONTEXT)
==================================================

Jika transcript menyebut kondisi pengujian, WAJIB dicatat di context
dan TIDAK BOLEH digabungkan dengan kondisi lain.

Kondisi yang wajib dicatat:
- "tanpa kipas", "dengan kipas", "pakai cooler"
- "dalam ruangan ber-AC", "outdoor", "suhu ruangan 25C"
- "mode Balanced", "mode Performance", "mode Game Optimization"
- "setelah 30 menit", "10 menit terakhir", "menit awal"
- "perjalanan", "battle", "idle"
- "120Hz", "60Hz", "mode default"

ATURAN:
A. Satu evidence hanya boleh merepresentasikan SATU kondisi. Jika
   transcript membandingkan dua kondisi (mis. tanpa kipas vs dengan
   kipas), buat DUA evidence terpisah, satu untuk tiap kondisi.
B. WAJIB isi related_evidence_ids untuk menautkan evidence dari
   kondisi berbeda yang membandingkan metrik yang sama.
C. context WAJIB memuat kondisi, bukan hanya topik.
   BURUK: "Pengujian Genshin Impact"
   BAIK:  "Pengujian Genshin Impact tanpa kipas, perjalanan"
D. Jika hasil di dua kondisi sama (mis. "kurang lebih mirip"),
   itu tetap dua evidence dengan konteks berbeda, bukan satu.

==================================================
19. RELATED_EVIDENCE_IDS — WAJIB DIISI UNTUK RELASI DALAM CHUNK
==================================================

related_evidence_ids adalah array berisi evidence_id (nomor lokal
chunk, format "E001", "E002", dst.) dari evidence LAIN DI CHUNK YANG
SAMA yang berhubungan dengan evidence ini.

🔥 BATASAN PENTING: Anda hanya bisa menautkan evidence yang ADA DI
CHUNK INI. Anda TIDAK BISA menautkan evidence dari chunk lain, karena
Anda tidak melihatnya. Kalau relasi seharusnya ada tapi targetnya
tidak ada di chunk ini, isi null -- biarkan sistem yang melengkapi.

FORMAT: gunakan nomor LOKAL (bukan final ID).
  BENAR: ["E003", "E007"]
  SALAH: ["45hfkSE5DvA-E003"]  ← jangan pakai prefix review_id
  SALAH: ["E5"]                 ← selalu 3 digit ("E005")

POLA WAJIB ISI (kalau targetnya ada di chunk yang sama):

A. PRESET ↔ HASIL (dalam game yang sama)
   Kalau Anda menulis evidence dengan attribute="graphics_preset"
   (mis. "highest 60 fps", "Ultra 90 fps"), dan DI CHUNK YANG SAMA
   ada evidence fps aktual untuk game yang sama
   (attribute mengandung "frame_rate" atau "fps"),
   → tulis related_evidence_ids menunjuk ke evidence fps tersebut.
   Sebaliknya, kalau Anda menulis evidence fps aktual dan presetnya
   ada di chunk yang sama, → tulis related_evidence_ids ke preset itu.

   Contoh konkret:
     E005: "Genshin Impact diuji pada preset Highest 60 fps"
           attribute="graphics_preset"
     E006: "Frame rate Genshin Impact di kisaran 30-40 fps"
           attribute="travel_frame_rate"
   → E005.related_evidence_ids = ["E006"]
   → E006.related_evidence_ids = ["E005"]
   (Dua arah; bukan hanya satu.)

B. KONDISI BERBEDA (metrik sama, kondisi beda)
   Kalau ada dua evidence metrik SAMA (mis. fps) tapi kondisi berbeda
   (mis. "tanpa kipas" vs "dengan kipas", "mode 120Hz" vs "mode 60Hz",
   "indoor" vs "outdoor"), dan keduanya di chunk ini
   → tulis related_evidence_ids saling menunjuk.

   Contoh:
     E010: "fps tanpa kipas: 30-40"
     E012: "fps dengan kipas: 30-40"
   → E010.related_evidence_ids = ["E012"]
   → E012.related_evidence_ids = ["E010"]

C. KLAIM VENDOR ↔ PENGUKURAN REVIEWER
   Klaim produsen (certainty="claimed_by_vendor") dan hasil uji
   reviewer (mis. "hasil pengujian", "dari pengujian kami") untuk
   metrik yang sama → tautkan.

D. DUA KOMPONEN SATU SERTIFIKASI
   IP67 angka 6 (debu) dan angka 7 (air) → tautkan.
   (Hanya jika Anda benar-benar memisahkan keduanya jadi dua evidence.)

E. KAMERA BERBEDA, SKENARIO SAMA
   ultrawide ↔ utama ↔ selfie pada kondisi/kualitas yang sama
   → tautkan.

F. PEMBANDING
   Produk ini ↔ pendahulunya untuk aspek yang sama → tautkan.

ATURAN TAMBAHAN:
- Kalau TIDAK ADA target yang memenuhi pola di atas di chunk ini,
  isi null. JANGAN menulis ref ke evidence yang tidak ada.
- WAJIB mengisi KEDUA ARAH saat relasinya mutual (preset→fps dan
  fps→preset). Bukan hanya satu arah.
- JANGAN menulis self-reference (evidence_id sendiri).
- Maksimal 6 ref per evidence.

==================================================
20. DUPLI KASI — DILARANG
==================================================

Dua evidence dianggap duplikat jika memenuhi SALAH SATU:
A. source_excerpt IDENTIK (karakter demi karakter).
B. source_coordinates menunjuk subtitle SRT yang SAMA
   (segment_start_index dan segment_end_index identik).
C. claim menyatakan proposisi yang sama meskipun kata berbeda
   (parafrase).

Jika duplikat ditemukan:
- Pertahankan SATU evidence dengan konteks paling lengkap dan
  spesifik (sebutkan game, kondisi, durasi).
- JANGAN buat evidence kedua dengan konteks yang lebih kabur.
- Jika ada dua aspek berbeda dari SRT yang sama (mis. satu tentang
  setting, satu tentang fps aktual), itu BUKAN duplikat — buat
  dua evidence dengan claim yang jelas berbeda, dan tautkan
  dengan related_evidence_ids.

CONTOH PELANGGARAN (pernah terjadi di produksi):
- E154 dan E155 sama-sama dari segment_start_index=271 dengan
  excerpt "frame rate itu ada di sekitar 30–40 fps".
- E154 punya konteks "dengan kipas", E155 tidak punya konteks game
  atau kipas.
- Solusi: hapus E155, atau jadikan E155 sebagai duplikat E154 dengan
  related_evidence_ids=["...-E154"] dan context yang diperjelas.

==================================================
21. ANTI-HALUSINASI LINTAS SEGMEN
==================================================

source_excerpt WAJIB berada dalam SATU subtitle SRT. DILARANG
menggabungkan potongan dari segmen berbeda, meskipun topiknya
sama.

Jika suatu klaim membutuhkan konteks dari segmen lain:
- JANGAN menyatukan teks.
- Buat evidence terpisah untuk setiap segmen.
- Tautkan dengan related_evidence_ids.

Forward inference (menggunakan kalimat berikutnya untuk memperluas
klaim) DAN backward inference (menggunakan kalimat sebelumnya untuk
memperluas klaim) DILARANG. Klaim harus didukung oleh excerpt itu
sendiri, bukan oleh konteks tetangga.

CONTOH PELANGGARAN:
- Excerpt: "AnTuTu-nya sudah 600.000-an"
  Klaim diperluas: "AnTuTu 10 3D Lite skornya 608000"
  → SALAH. Angka 608000 berasal dari segmen lain (baris 192).
  → BENAR: excerpt tetap "AnTuTu-nya sudah 600.000-an",
    klaim "AnTuTu berada di kisaran 600.000-an".

- Excerpt: "itu sudah highest 60"
  Klaim diperluas: "Genshin Impact berjalan 60 fps stabil"
  → SALAH. "Highest 60" adalah nama preset; "60 fps stabil" adalah
    hasil performa yang tidak pernah dinyatakan di segmen itu.
  → BENAR: klaim "Genshin Impact diuji pada preset Highest 60 fps",
    ditautkan ke evidence fps aktual lewat related_evidence_ids.

==================================================
PERBEDAAN OBSERVATION vs OPINION (PENTING)
==================================================

- OBSERVATION = deskripsi netral tentang perilaku produk yang dapat diamati/diukur oleh orang lain, TANPA penilaian subjektif.
- OPINION = penilaian subjektif reviewer yang mengandung kata evaluatif.

Contoh BENAR (OBSERVATION, reviewer_assessment = null):
- "video pada 1080p 30 fps sudah stabil" → OBSERVATION
- "dynamic range video tetap konsisten" → OBSERVATION
- "frame rate turun dari 45 ke 30 fps" → OBSERVATION
- "warna kamera utama dan ultrawide konsisten" → OBSERVATION
- "bodinya tipis" (deskripsi fisik) → OBSERVATION

Contoh BENAR (OPINION, reviewer_assessment = positive/negative/neutral):
- "video sudah stabil, mantap" → OPINION (positive)
- "hasilnya tergolong oke" → OPINION (positive)
- "kualitasnya sudah memadai untuk kelas harganya" → OPINION (positive)
- "kualitas audio tergolong rapi" → OPINION (positive)
- "paket penjualan tergolong minim" → OPINION (negative)
- "performanya meningkat jauh" → OPINION (positive)
- "haptic feedback terasa agak panjang" → OPINION (negative)

🔥 Contoh PEMISAHAN FAKTA + OPINI dalam satu kalimat:
Kalimat: "kita dapat baterainya habis setelah 17 jam 42 menit. Ini sepertinya kurang asyik untuk baterai 5000 mAh."

BENAR → DUA evidence:
① MEASUREMENT: claim "Durasi pemutaran video 17 jam 42 menit"
  source_excerpt: "kita dapat baterainya habis setelah 17 jam 42 menit"
  reviewer_assessment: null
② OPINION: claim "Reviewer menilai baterai 5000 mAh kurang asyik"
  source_excerpt: "sepertinya kurang asyik untuk baterai 5000 mAh"
  reviewer_assessment: negative

SALAH → SATU evidence dengan source_excerpt yang menggabungkan keduanya:
claim "Durasi pemutaran video 17 jam 42 menit dan dinilai kurang asyik"
source_excerpt: "baterainya habis setelah 17 jam 42 menit. Ini sepertinya kurang asyik"
→ INI DILARANG (menggabungkan fakta dan opini dalam satu excerpt)

🔥 Contoh PEMISAHAN REKOMENDASI + OPINI dalam satu kalimat (pola sama
dengan FACT+OPINION di atas, sering terlewat oleh model):

Kalimat: "sebaiknya gunakan mode Balanced saja, ini sudah cukup kencang
dan suhu permukaan pun terjaga relatif aman"

BENAR → DUA evidence:
① RECOMMENDATION: claim "Disarankan menggunakan mode Balanced saat gaming"
  source_excerpt: "sebaiknya gunakan mode Balanced saja"
  reviewer_assessment: null
② OPINION: claim "Reviewer menilai performa mode Balanced cukup kencang dan suhu aman"
  source_excerpt: "sudah cukup kencang dan suhu permukaan pun terjaga relatif aman"
  reviewer_assessment: positive

SALAH → SATU evidence RECOMMENDATION yang menelan kata evaluatif "cukup":
claim "Disarankan mode Balanced karena performa kencang dan suhu aman"
→ INI DILARANG. Ingat: begitu ada kata evaluatif (cukup, mantap, oke, dll.)
  di dalam kalimat rekomendasi, WAJIB dipecah — bagian rekomendasi murni
  tetap RECOMMENDATION (assessment null), bagian evaluatifnya jadi OPINION
  terpisah. JANGAN biarkan kata evaluatif "menumpang" di evidence
  RECOMMENDATION.

Panduan cepat:
- Jika ada kata evaluatif (oke, mantap, bagus, jelek, tergolong, memadai, minim, jauh, agak, kurang, dll.) → OPINION
- Jika tidak ada kata evaluatif → OBSERVATION atau FACT

KATA EVALUATIF YANG MENJADI TANDA OPINION (contoh): mantap, bagus, cakep,
jelek, kurang, buruk, hebat, luar biasa, mengecewakan, mengesankan, oke,
cukup, cukup jelas, cukup bagus, cukup baik, cukup luas, cukup stabil,
sangat baik, terlalu panas, kurang nyaman, tergolong, memadai, minim,
jauh, agak, dll.

CATATAN: kata "cukup" dalam frasa seperti "cukup jelas", "cukup bagus",
"cukup luas" adalah penanda OPINION, bukan OBSERVATION. Jika reviewer
menulis "masih kelihatan dengan cukup jelas", itu adalah penilaian
subjektif → OPINION positive, bukan OBSERVATION.

CATATAN TAMBAHAN: frasa "kurang lebih" adalah idiom netral yang berarti
"sekitar/kira-kira" (mis. "hasilnya kurang lebih mirip seperti sebelumnya"),
BUKAN penanda evaluatif. JANGAN treat "kurang lebih" sebagai trigger kata
"kurang" yang evaluatif. Bedakan:
  - "kurang lebih mirip" → netral (OBSERVATION), "kurang lebih" = "sekitar"
  - "kurang nyaman" / "kurang cocok" → evaluatif (OPINION), "kurang" = "tidak cukup"
Aturan: kalau "kurang" langsung diikuti "lebih", itu idiom netral. Kalau
"kurang" berdiri sendiri mengomentari kualitas, itu evaluatif.

==================================================
CONTOH WAJIB — OPINION vs OBSERVATION (DARI KONTEKS KAMERA & DISPLAY)
==================================================

KASUS YANG SERING SALAH — semua di bawah ini WAJIB type=OPINION:

- "dynamic range juga cukup luas ya"              → OPINION positive
- "wajahku masih kelihatan dengan cukup bagus"    → OPINION positive
- "Untuk autofocus-nya ini bagus banget"          → OPINION positive
- "langitnya masih kelihatan dengan cukup jelas"  → OPINION positive
- "skin tone ini juga masih terjaga dengan cukup baik" → OPINION positive
- "bezel Samsung A26 5G ini masih tergolong tebal" → OPINION negative
- "Untuk stabilizer ini sama-sama bagus ya"       → OPINION positive
- "Oke, ini cakep banget sih"                     → OPINION positive
- "harganya cukup mahal ya, guys"                 → OPINION negative
- "experience dengerin musik di HP ini tentunya kurang ya" → OPINION negative
- "ini merupakan sebuah PR yang cukup besar"      → OPINION negative

🔥 BARU (dari pola produksi nyata):
- "view angle-nya juga bagus"                     → OPINION positive
- "kontrasnya juga bagus sharp"                   → OPINION positive (split jika perlu)
- "Untuk selfie juga oke bisa wide selfie"        → OPINION positive (split)
- "presisinya mantap"                             → OPINION positive
- "sudah sangat memadai"                          → OPINION positive
- "A56 lebih premium lah"                         → OPINION positive
- "tingkat kecerahan yang bagus"                  → OPINION positive
- "HDR-nya bagus"                                 → OPINION positive
- "videonya kurang wide"                          → OPINION negative
- "warna juga oke, agak sedikit muted"            → OPINION positive (split)
- "fokusnya juga oke"                             → OPINION positive
- "Grafisnya bagus dan terasa smooth banget"      → OPINION positive (split)

ATURAN TEGAS (WAJIB):
Jika claim ATAU source_excerpt mengandung SALAH SATU dari:
  cukup, cukup luas, cukup bagus, cukup jelas, cukup baik, cukup stabil,
  cukup mahal, cukup besar, bagus, bagus banget, cakep, cakep banget,
  tergolong, tergolong tebal, memadai, kurang, terlalu, agak, mantap,
  oke, luar biasa, luar biasa bagus, hebat, jelek, buruk, PR yang besar,
  keren, jempolan, premium, layak, recommended, worth it,
  mengecewakan, mengesankan
→ type WAJIB = OPINION, reviewer_assessment WAJIB diisi (positive/negative).

JANGAN PERNAH memakai OBSERVATION atau FACT untuk claim yang mengandung
kata-kata di atas, meskipun klaim tersebut juga menyampaikan informasi
teknis. Jika ada informasi teknis + kata evaluatif, buat DUA evidence:
  ① OBSERVATION/FACT dengan source_excerpt hanya bagian teknis
  ② OPINION dengan source_excerpt hanya bagian evaluatif

==================================================
🔥 ATURAN SPLIT COMPOUND (SANGAT PENTING — POLA PRODUKSI)
==================================================

Satu kalimat yang memuat KATA EVALUATIF (bagus/oke/mantap/dll.)
BERSAMA deskripsi teknis (jernih/terang/kontras stabil/dll.) WAJIB
DIPECAH menjadi DUA evidence terpisah. JANGAN gabungkan jadi satu
OBSERVATION atau FACT.

Cara split:
  ① OBSERVATION / FACT: hanya bagian deskriptif/terukur
     source_excerpt: hanya bagian deskriptif (TANPA kata evaluatif)
     reviewer_assessment: null
  ② OPINION: bagian yang memuat kata evaluatif
     source_excerpt: hanya bagian opini
     reviewer_assessment: positive / negative

Contoh nyata dari produksi (WAJIB DIPECAH):

📌 Kalimat: "Super AMOLED-nya jernih, terang dan view angle-nya juga bagus"
   SALAH → satu OBSERVATION dengan excerpt utuh.
   BENAR → DUA evidence:
     ① OBSERVATION: excerpt "Super AMOLED-nya jernih, terang"
        claim: "Layar Super AMOLED tampil jernih dan terang"
        reviewer_assessment: null
     ② OPINION: excerpt "view angle-nya juga bagus"
        claim: "Reviewer menilai view angle layar bagus"
        reviewer_assessment: positive

📌 Kalimat: "Untuk selfie juga oke bisa wide selfie"
   SALAH → OBSERVATION dengan excerpt utuh.
   BENAR → DUA evidence:
     ① OPINION: excerpt "Untuk selfie juga oke"
        claim: "Reviewer menilai kamera selfie oke"
        reviewer_assessment: positive
     ② OBSERVATION: excerpt "bisa wide selfie"
        claim: "Kamera selfie mendukung mode wide selfie"
        reviewer_assessment: null

📌 Kalimat: "kontrasnya juga bagus sharp"
   BENAR → DUA evidence:
     ① OPINION: excerpt "kontrasnya juga bagus"
     ② OBSERVATION: excerpt "kontrasnya sharp"
        (jika "sharp" dianggap deskriptif di SRT)

📌 Kalimat: "kamera bagus di siang hari, tapi di malam hari detail turun"
   SALAH → satu OBSERVATION.
   BENAR → DUA evidence:
     ① OPINION: excerpt "kamera bagus di siang hari"
        reviewer_assessment: positive
     ② OBSERVATION: excerpt "di malam hari detail turun"
        reviewer_assessment: null

📌 Kalimat: "noise-nya juga lebih minim di sini"
   SALAH → OBSERVATION (karena "minim" dianggap deskriptif).
   BENAR → OPINION
     (kecuali excerpt persis "minim noise" / "noise minim" — itu whitelist teknis)
     claim: "Reviewer menilai noise lebih minim"
     reviewer_assessment: positive

TIPS PRAKTIS:
- Sebelum output, periksa SETIAP evidence non-OPINION. Kalau excerpt-nya
  memuat salah satu kata di daftar evaluatif, WAJIB dipindah ke OPINION
  atau displit.
- Kata "turun", "meningkat", "berkurang", "bertambah" SENDIRI bukan
  evaluatif — itu deskriptif. Tapi kalau ada "kurang", "bagus", "oke",
  "premium" di kalimat yang sama, pisahkan.

🔥 CATATAN PENTING — "OKE" dan "PREMIUM":
Kata "oke" dalam konteks review produk SELALU evaluatif, BUKAN
discourse marker, KECUALI di awal kalimat diikuti koma atau sapaan
("Oke, kita lanjut"). Contoh yang WAJIB OPINION:
  - "Untuk selfie juga oke bisa wide selfie" → OPINION ("selfie juga oke")
  - "kontrasnya oke untuk kelasnya" → OPINION
  - "warna juga oke, agak sedikit muted" → OPINION
  - "fokusnya juga oke" → OPINION

Kata "premium" JUGA selalu evaluatif (penilaian kualitas):
  - "A56 lebih premium lah" → OPINION
  - "kerasa banget premiumnya" → OPINION

Kata "mantap", "memadai", "kurang", "minim" (bukan "minim noise"),
"jauh" (dalam konteks komparatif kualitas) juga selalu evaluatif.

==================================================
PRINSIP KELENGKAPAN (WAJIB DIPERIKSA SEBELUM OUTPUT)
==================================================

Chunk dinyatakan TIDAK LENGKAP jika memuat salah satu dari hal berikut
 tetapi TIDAK menghasilkan evidence yang sesuai.

PRINSIP 1 — SATU KOMPONEN, SATU EVIDENCE PER ATRIBUT
  Untuk setiap komponen/produk yang disebut, pastikan setiap atribut
  berikut dipecah menjadi evidence terpisah bila keduanya muncul:
    - Kapasitas vs tipe (RAM 8GB vs LPDDR4X; storage 256GB vs UFS;
      charging 25W vs charger asli/bukan).
    - Nilai vs satuan (fab 5nm; brightness 1025 nits; refresh 120Hz).
    - Nama vs fungsi (Knox Vault vs fungsinya; Vision Booster vs efeknya).

PRINSIP 2 — SATU PENGUJIAN, SATU EVIDENCE PER METRIK
  Untuk setiap skenario pengujian (benchmark, game, playback, charging),
  setiap metrik berikut harus muncul sebagai evidence terpisah bila
  disebutkan:
    - Score / FPS / durasi
    - Suhu
    - Battery drain
    - Setting/mode
    - Stabilitas
    - Kesimpulan reviewer
  CATATAN: untuk game, setting/mode adalah NAMA PRESET — lihat rule 17.
  FPS aktual adalah hasil terpisah, bukan bagian dari setting.

PRINSIP 3 — SATU FITUR SOFTWARE, SATU EVIDENCE
  Cluster fitur software WAJIB dipecah per fitur:
    - "Edge Panel, Separate App Sound, Pause USB PD, Mode & Routines"
      → 4 evidence terpisah.
    - "Object Eraser, AI Select, Circle to Search, Filters"
      → 4 evidence terpisah.
    - "Knox Vault, Secure Folder, Auto-Blocker"
      → 3 evidence terpisah.

PRINSIP 4 — OPINI TIDAK BOLEH TENGGELAM
  Setiap kalimat yang memuat kata evaluatif (bagus, kurang, cukup,
  tergolong, memadai, dll.) WAJIB menghasilkan minimal satu evidence
  OPINION, meskipun sudah ada evidence FACT/OBSERVATION dari kalimat
  yang sama. Pisahkan, jangan digabung.

PRINSIP 5 — LIMITASI HARUS MUNCUL
  Setiap keterbatasan yang disebutkan reviewer WAJIB menghasilkan
  evidence, termasuk:
    - "belum aktif di atas 1080p 30fps"
    - "tidak ada opsi 60fps di kamera selfie"
    - "refresh rate non-adaptif"
    - "Pro mode hanya di kamera utama"
    - "mono speaker"
    - "tanpa charger di paket"
    - "notch waterdrop"
  Jika reviewer menyebut keterbatasan tapi tidak ada evidence,
  ekstraksi dianggap tidak lengkap.

  🔥 PENTING: limitasi/kekurangan yang dinyatakan TANPA kata evaluatif
  eksplisit (lihat daftar kata evaluatif di atas) TETAP type FACT atau
  OBSERVATION dengan reviewer_assessment = null — JANGAN otomatis
  menganggap limitasi sebagai opini negatif hanya karena isinya terdengar
  kurang menguntungkan bagi produk.
  Contoh BENAR: "tidak ada opsi perekaman 60fps di kamera selfie"
    → FACT, reviewer_assessment: null (tidak ada kata evaluatif di excerpt)
  Contoh SALAH (dilarang): sama seperti di atas tapi reviewer_assessment
    diisi "negative" → INI DILARANG, tidak ada kata evaluatif eksplisit
    yang mendukung assessment tersebut.
  Kalau reviewer memang menambahkan kata evaluatif pada limitasi tsb
  (mis. "sayangnya tidak ada 60fps"), BARU dipecah jadi dua evidence
  (FACT limitasi + OPINION "sayangnya") mengikuti pola FACT+OPINION di atas.

PRINSIP 6 — KESIMPULAN REVIEWER
  Jika chunk memuat verdict, target user, atau rekomendasi
  ("cocok untuk X", "recommended untuk Y"), ini WAJIB jadi evidence
  RECOMMENDATION atau OPINION, jangan diabaikan.

==================================================
Pemeriksaan internal singkat sebelum output:
- Apakah semua claim didukung source_excerpt?
- Apakah tidak ada informasi dari luar transcript?
- Apakah tipe evidence dan reviewer_assessment sesuai aturan?
- Apakah tidak ada duplicate? (Cek excerpt identik, SRT identik, parafrase)
- Apakah semua angka/qualifier dipertahankan?
- Apakah fakta dan opini sudah dipisahkan jika keduanya ada dalam satu kalimat?
- Apakah source_excerpt TIDAK memendekkan kata apa pun dari subtitle asli?
  (Contoh pelanggaran yang PERNAH LOLOS ke produksi: "frame rate-nya" ditulis
  jadi "frame-nya" — cek ulang SETIAP kata dalam source_excerpt cocok literal
  karakter-demi-karakter dengan subtitle sumber, terutama kata majemuk yang
  mengandung "-nya", "rate", "speed", "size".)
- Apakah evidence preset sudah ditautkan ke evidence fps aktual via
  related_evidence_ids? (rule 17)
- Apakah evidence dari kondisi berbeda sudah ditautkan via
  related_evidence_ids? (rule 18)
- Apakah tidak ada klaim yang memperluas excerpt menggunakan konteks
  segmen lain? (rule 21)

Output hanya JSON array murni tanpa markdown. Jika tidak ada evidence: [].

SINTAKS WAJIB: Setiap nama field ditulis PERSIS seperti daftar di atas —
tanpa prefiks "_", tanpa sufiks, tanpa perubahan huruf. Setiap nama field
WAJIB diapit dua tanda kutip ganda lengkap (pembuka + penutup), mis.
"related_evidence_ids" — BUKAN _related_evidence_ids dan BUKAN
"related_evidence_ids tanpa kutip penutup. Output harus lolos JSON.parse.

CONTOH OUTPUT (perhatikan field attribute & attribute_value):

[
  {
    "evidence_id": "E001",
    "topic": "durability",
    "subtopic": "gorilla-glass",
    "type": "FACT",
    "claim": "Back cover menggunakan Gorilla Glass Victus+ menurut keterangan Samsung",
    "value": null,
    "unit": null,
    "attribute": "protection_type",
    "attribute_value": "Gorilla Glass Victus+",
    "context": "Material back cover",
    "comparison_target": null,
    "reviewer_assessment": null,
    "certainty": "claimed_by_vendor",
    "source_excerpt": "berdasarkan keterangan Samsung, back cover ini sudah pakai Gorilla Glass Victus+",
    "related_evidence_ids": null
  },
  {
    "evidence_id": "E002",  
    "topic": "gaming",
    "subtopic": "genshin-impact",
    "type": "FACT",
    "claim": "Genshin Impact diuji pada preset grafis Highest 60 fps",
    "value": null,
    "unit": null,
    "attribute": "graphics_preset",
    "attribute_value": "Highest 60 fps",
    "context": "Pengujian Genshin Impact, pengaturan grafis",
    "comparison_target": null,
    "reviewer_assessment": null,
    "certainty": "explicit",
    "source_excerpt": "kita menguji dengan setting grafis Highest 60 fps",
    "related_evidence_ids": ["...-E149", "...-E154"]
  }
]
`;

// ============================================================
// LEXICAL CONTRACT — PRODUCTION VARIANT A
// ============================================================
// Salinan verbatim dari:
//   src/evidence/harness/experiments/prompts/lexical-contract.ts
//
// Enforcement: SHA-256 hash A harus match target di
// scripts/verify-prompt-hash.ts. Jangan edit blok ini tanpa
// memperbarui target hash.
// ============================================================

const LEXICAL_CONTRACT_INLINE = `
==================================================
SUBTOPIC — KONTRAK LEXICAL
==================================================

subtopic HARUS berupa kata/frasa yang muncul LITERAL
di dalam CANDIDATE SPAN yang relevan.

Candidate span adalah unit teks minimum dari source
yang mendukung claim (bukan seluruh chunk).

- JANGAN gunakan sinonim atau istilah user-friendly.
  (contoh SALAH: "kamera depan" jika candidate span
  menulis "kamera selfie").
- JANGAN gunakan term generik jika ada term spesifik
  literal yang tersedia di candidate span.
  (contoh SALAH: "kamera" jika candidate span menulis
  "kamera ultrawide").
- Jika tidak ada term literal di candidate span yang
  mewakili subjek, gunakan null.
- Panjang: 1-3 kata. Bahasa: ikuti aturan CANONICAL TOPIC di bawah.
`;

const CANONICAL_TOPICS_INLINE = `
==================================================
CANONICAL TOPIC (WAJIB dari daftar ini)
==================================================
Pilih SATU topic dari daftar berikut. Format lowercase-kebab-case:

  design          — material, dimensi, tombol, port, warna, build quality
  pricing         — harga produk, positioning harga, harga rilis, harga pasar, value-for-money
  display         — panel, resolusi, refresh rate, brightness, bezel, notch
  performance     — chipset, RAM, storage, fab process, sistem pendingin
  benchmark       — AnTuTu, Geekbench, 3DMark, GFXBench, dll
  gaming          — pengujian game (per game, per metrik)
  camera          — hardware kamera, foto, video, stabilisasi, lensa
  battery         — kapasitas, battery test, real-world drain
  charging        — watt, kecepatan, temperature saat charging
  software        — OS, One UI, fitur software, AI, fitur keamanan
  audio           — speaker, mikrofon, jack, codec Bluetooth
  connectivity    — 5G, Wi-Fi, Bluetooth, NFC, USB, GPS
  sensors         — gyro, compass, fingerprint, face unlock
  durability      — IP rating, Gorilla Glass, sertifikasi ketahanan
  retail-package  — isi kotak, charger, aksesoris bawaan
  accessories     — aksesoris terpisah, harga aksesoris
  real-world      — pengalaman penggunaan sehari-hari
  comparison      — perbandingan eksplisit dengan produk lain
  verdict         — kesimpulan reviewer, target user, rekomendasi

Jika chunk memuat kategori yang TIDAK ada di daftar ini, gunakan
topic="other" dan tulis subtopic deskriptif.

==================================================
ATURAN PEMILIHAN TOPIC
==================================================
Pilih topic berdasarkan ATRIBUT UTAMA yang dibicarakan, bukan kata
yang muncul di dalam claim.

Contoh SALAH:
  Claim: "Layar cerah untuk kelas harganya"
  Topic: "pricing"  ← SALAH (kata "harga" cuma context)
  Topic: "display"  ← BENAR (atribut utama = layar)

Contoh BENAR:
  Claim: "Harga Galaxy A26 5G di bawah 4 juta"
  Topic: "pricing"  ← BENAR (pernyataan harga produk)

  Claim: "Layar cerah untuk kelas harganya"
  Topic: "display"  ← BENAR (atribut utama = layar)

Aturan: "harga" di dalam claim adalah SINYAL pricing HANYA jika
claim menyatakan harga aktual, positioning harga, atau value-for-
money. "Harga" sebagai context pembanding (mis. "untuk kelas
harganya") tetap mengikuti topic atribut utamanya.

==================================================
ATURAN SUBTOPIC
==================================================
- Format: lowercase-kebab-case.
- Bahasa: English (kanonik) bila memungkinkan; Bahasa Indonesia bila
  tidak ada padanan natural.
- Panjang: 1–3 kata.
- HARUS LITERAL dari candidate span (lihat LEXICAL CONTRACT di atas).
- TIDAK BOLEH identik dengan topic.
- TIDAK BOLEH sinonim dari topic.
- Bila tidak ada term literal yang mewakili subjek, gunakan null.

Contoh BENAR:
  topic="gaming",  subtopic="genshin-impact"
  topic="gaming",  subtopic="wuthering-waves"
  topic="benchmark", subtopic="antutu-10"
  topic="software", subtopic="knox-vault"
  topic="software", subtopic="circle-to-search"
  topic="display",  subtopic="peak-brightness"
  topic="display",  subtopic="color-gamut"
  topic="battery",  subtopic="youtube-playback"

Contoh SALAH:
  topic="design",   subtopic="design"          ← identik
  topic="camera",   subtopic="kamera"          ← sinonim
  topic="display",  subtopic="layar terang"    ← bukan kebab-case
  topic="audio",    subtopic="speaker"         ← terlalu generik, pakai mono-speaker/stereo-speaker
`;

// PENTING: anchor harus persis mengakhiri BLOK DAFTAR FIELD, bukan
// berhenti di tengah ("certainty, source_excerpt," masih berlanjut
// dengan attribute/attribute_value/related_evidence_ids). Anchor lama
// tidak pernah ditemukan (indexOf === -1), sehingga LEXICAL_CONTRACT_INLINE
// dan CANONICAL_TOPICS_INLINE tersisip di karakter ke-26, tepat di tengah
// kalimat pembuka "Anda adalah AI ekstraktor...". Diperbaiki + diberi guard
// agar regresi ini tidak bisa terjadi lagi secara diam-diam.
const INSERTION_ANCHOR = 'attribute, attribute_value, related_evidence_ids.\n';

const _anchorIndex = ANALYSIS_PROMPT_EVIDENCE.indexOf(INSERTION_ANCHOR);

if (_anchorIndex === -1) {
  throw new Error(
    'ANALYSIS_PROMPT_EVIDENCE_A: INSERTION_ANCHOR tidak ditemukan di ' +
    'ANALYSIS_PROMPT_EVIDENCE. Prompt utama kemungkinan berubah tanpa ' +
    'anchor ini disesuaikan. Perbaiki INSERTION_ANCHOR sebelum deploy.'
  );
}

const _anchorEnd = _anchorIndex + INSERTION_ANCHOR.length;

export const ANALYSIS_PROMPT_EVIDENCE_A =
  ANALYSIS_PROMPT_EVIDENCE.slice(0, _anchorEnd) +
  LEXICAL_CONTRACT_INLINE + '\n' +
  CANONICAL_TOPICS_INLINE + '\n' +
  ANALYSIS_PROMPT_EVIDENCE.slice(_anchorEnd);

export default {
  ANALYSIS_PROMPT_SUMMARY,
  ANALYSIS_PROMPT_EVIDENCE,
};