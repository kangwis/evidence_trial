import { describe, test, expect } from 'vitest';
import { ValueValidator } from '../value';

describe('VALUE VALIDATOR', () => {
  test('PASS: 1/30 detik', () => {
    const result = ValueValidator.validate('1/30', 'detik');
    expect(result.status).toBe('PASS');
  });

  test('PASS: 1/60 detik', () => {
    const result = ValueValidator.validate('1/60', 'detik');
    expect(result.status).toBe('PASS');
  });

  test('SUSPECT: 4K 30 fps tanpa unit', () => {
    const result = ValueValidator.validate('4K 30 fps', null);

    expect(result.pass).toBe(true);
    expect(result.status).toBe('SUSPECT');
    expect(result.severity).toBe('MEDIUM');
  });

  test('PASS: 358', () => {
    const result = ValueValidator.validate('358', 'nits');
    expect(result.status).toBe('PASS');
  });

  test('FAIL: 8/256 GB', () => {
    const result = ValueValidator.validate('8/256', 'GB');
    expect(result.status).toBe('FAIL');
  });

  test('SUSPECT: 3/4 %', () => {
    const result = ValueValidator.validate('3/4', '%');
    expect(result.status).toBe('SUSPECT');
  });

  test('PASS: attribute_value saja tanpa value', () => {
    const result = ValueValidator.validate(null, null, 'protection_type', 'IP67');
    expect(result.status).toBe('PASS');
  });
});

// ------------------------------------------------------------
// Tambahan: desimal koma dan rentang (3 sisa karantina VALUE, replay 15 video)
// ------------------------------------------------------------
// Tiga sisa karantina VALUE dari replay 15 video:
//   "1,5" + jam (desimal koma), "40-50" + cm, "30-35" + % (rentang berunit lain).
describe('VALUE VALIDATOR: desimal koma', () => {
  test.each([['1,5', 'jam'], ['1.5', 'jam'], ['6,7', 'inci'], ['-3,5', 'derajat']])(
    '%s + %s = numerik (PASS)', (v, u) => {
      expect(ValueValidator.validate(v, u).status).toBe('PASS');
    });
  test('non-numerik tetap SUSPECT HIGH', () => {
    const r = ValueValidator.validate('abc', 'jam');
    expect(r.status).toBe('SUSPECT');
    expect(r.severity).toBe('HIGH');
  });
  test('"1,5,2" bukan angka tunggal', () => {
    expect(ValueValidator.validate('1,5,2', 'jam').status).toBe('SUSPECT');
  });
});

describe('VALUE VALIDATOR: rentang untuk satuan apa pun kecuali penyimpanan', () => {
  test.each([
    ['40-50', 'cm'],
    ['30-35', '%'],
    ['40–50', 'cm'],
    ['30 - 45', 'fps'],
    ['1,5-2', 'jam'],
    ['3-4', 'juta']
  ])('SUSPECT MEDIUM: rentang %s %s', (value, unit) => {
    const result = ValueValidator.validate(value, unit);

    expect(result.pass).toBe(true);
    expect(result.status).toBe('SUSPECT');
    expect(result.severity).toBe('MEDIUM');
  });

  test('PASS: rentang numerik tanpa satuan', () => {
    const result = ValueValidator.validate('40-50', '');

    expect(result.pass).toBe(true);
    expect(result.status).toBe('PASS');
    expect(result.severity).toBe('LOW');
  });

  test.each([
    ['8-256', 'gb'],
    ['8-256', 'GB'],
    ['4-64', 'mb'],
    ['1-2', 'tb']
  ])('SUSPECT HIGH: rentang penyimpanan %s %s', (value, unit) => {
    const result = ValueValidator.validate(value, unit);

    expect(result.pass).toBe(false);
    expect(result.status).toBe('SUSPECT');
    expect(result.severity).toBe('HIGH');
  });

  test('FAIL HIGH: 8/256 GB', () => {
    const result = ValueValidator.validate('8/256', 'GB');

    expect(result.pass).toBe(false);
    expect(result.status).toBe('FAIL');
    expect(result.severity).toBe('HIGH');
  });
});

describe('VALUE VALIDATOR: frequency units and compound values', () => {
  test.each([
    ['2.75', 'GHz'],
    ['2.4', 'GHz'],
    ['2400', 'MHz'],
    ['120000', 'kHz']
  ])('PASS: frekuensi %s %s', (value, unit) => {
    const result = ValueValidator.validate(value, unit);

    expect(result.pass).toBe(true);
    expect(result.status).toBe('PASS');
  });

  test.each([
    ['28-35', 'fps'],
    ['17:42', 'jam'],
    ['4K 30 fps', 'fps']
  ])('SUSPECT MEDIUM: compound %s %s', (value, unit) => {
    const result = ValueValidator.validate(value, unit);

    expect(result.pass).toBe(true);
    expect(result.status).toBe('SUSPECT');
    expect(result.severity).toBe('MEDIUM');
  });

  test('FAIL HIGH: RAM dan storage dalam satu value', () => {
    const result = ValueValidator.validate('8/256', 'GB');

    expect(result.pass).toBe(false);
    expect(result.status).toBe('FAIL');
    expect(result.severity).toBe('HIGH');
  });

  test('SUSPECT MEDIUM: nama produk kategorik tanpa unit', () => {
    const result = ValueValidator.validate('Gorilla Glass Victus', null);

    expect(result.pass).toBe(true);
    expect(result.status).toBe('SUSPECT');
    expect(result.severity).toBe('MEDIUM');
  });
});

describe('VALUE VALIDATOR: aperture f-number', () => {
  test('PASS: bukaan kamera f/2.2', () => {
    const result = ValueValidator.validate('2.2', 'f', 'bukaan kamera');
    expect(result.status).toBe('PASS');
    expect(result.pass).toBe(true);
  });

  test('PASS: aperture f/1.8', () => {
    const result = ValueValidator.validate('1.8', 'f', 'aperture');
    expect(result.status).toBe('PASS');
  });

  test('SUSPECT HIGH: unit f pada atribut non-kamera', () => {
    const result = ValueValidator.validate('2.2', 'f', 'berat perangkat');
    expect(result.status).toBe('SUSPECT');
    expect(result.severity).toBe('HIGH');
  });
});

describe('VALUE VALIDATOR: satuan daya', () => {
  test.each([
    ['2.5', 'Watt'],
    ['3.17', 'watts'],
    ['25', 'W'],
  ])('PASS: daya %s %s', (value, unit) => {
    const result = ValueValidator.validate(value, unit);

    expect(result.pass).toBe(true);
    expect(result.status).toBe('PASS');
  });
});

describe('VALUE VALIDATOR: mata uang', () => {
  test.each([
    ['2799000', 'Rp'],
    ['4299000', 'rupiah'],
    ['4299000', 'IDR'],
  ])('PASS: harga %s %s', (value, unit) => {
    const result = ValueValidator.validate(value, unit);

    expect(result.pass).toBe(true);
    expect(result.status).toBe('PASS');
  });
});

describe('VALUE VALIDATOR: perlindungan compound storage', () => {
  test.each([
    ['8/256', 'GB'],
    ['4/64', 'MB'],
    ['1/2', 'TB'],
  ])('FAIL HIGH: %s %s', (value, unit) => {
    const result = ValueValidator.validate(value, unit);

    expect(result.pass).toBe(false);
    expect(result.status).toBe('FAIL');
    expect(result.severity).toBe('HIGH');
  });
});

describe('VALUE VALIDATOR: satuan classifier dan benchmark', () => {
  test.each([
    ['3', 'buah'],
    ['1', 'game'],
    ['918340', 'poin'],
    ['912427', 'poin'],
    ['61', 'persen'],
    ['5', 'jutaan'],
    ['2', 'jutaan'],
  ])('PASS: classifier/benchmark %s %s', (value, unit) => {
    const result = ValueValidator.validate(value, unit);

    expect(result.pass).toBe(true);
    expect(result.status).toBe('PASS');
  });

  // GUARD: compound storage tetap FAIL HIGH (tidak boleh terpengaruh)
  test.each([
    ['8/256', 'GB'],
    ['4/64', 'MB'],
    ['1/2', 'TB'],
  ])('FAIL HIGH (tidak terpengaruh): %s %s', (value, unit) => {
    const result = ValueValidator.validate(value, unit);

    expect(result.pass).toBe(false);
    expect(result.status).toBe('FAIL');
    expect(result.severity).toBe('HIGH');
  });
});

describe('VALUE VALIDATOR: count classifiers & currency variants', () => {
  test.each([
    ['2', 'varian'],
    ['1', 'speaker'],
    ['3', 'kamera'],
    ['3', 'warna'],
    ['3047', 'point'],
    ['3047', 'points'],
    ['448', 'Dolar Singapura'],
    ['448', 'SGD'],
    ['448', 'sgd'],
  ])('PASS: %s %s', (value, unit) => {
    const result = ValueValidator.validate(value, unit);
    expect(result.pass).toBe(true);
    expect(result.status).toBe('PASS');
  });

  // GUARD: unit tidak dikenal tetap SUSPECT HIGH
  test('SUSPECT HIGH: unit tidak dikenal tetap ditolak', () => {
    const result = ValueValidator.validate('3', 'unit-tidak-dikenal');
    expect(result.pass).toBe(true);
    expect(result.status).toBe('SUSPECT');
    expect(result.severity).toBe('HIGH');
  });

  // GUARD: compound storage tidak terpengaruh
  test.each([
    ['8/256', 'GB'],
    ['4/64', 'MB'],
    ['1/2', 'TB'],
  ])('FAIL HIGH (tidak terpengaruh): %s %s', (value, unit) => {
    const result = ValueValidator.validate(value, unit);
    expect(result.pass).toBe(false);
    expect(result.status).toBe('FAIL');
    expect(result.severity).toBe('HIGH');
  });
});
