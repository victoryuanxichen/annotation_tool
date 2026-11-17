import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BufferByteReader, boundaryUs as indexBoundaryUs, indexMp4 } from '../../src/core/mp4';
import { parseCsv, protectFormula, quoteCsvField, unprotectFormula, writeCsv } from '../../src/core/formats/csv';
import { buildExportRecords, defaultSidecarName, serializeCsv, serializeJson, videoStem } from '../../src/core/formats/export';
import { parseAnnotationFile, toSegments, verifyAgainstVideo } from '../../src/core/formats/import';
import type { ExportDocument, ParsedAnnotation, VideoIdentity } from '../../src/core/formats/types';
import type { Segment, VideoMeta } from '../../src/core/types';

// --- Fixtures -----------------------------------------------------------------------------------

const SHA = 'ab'.repeat(32);
const N = 500;
const FRAME_US = 40_000;
const synthBoundary = (b: number): number => b * FRAME_US;
const meta: VideoMeta = { sha256: SHA, frameCount: N, durationUs: N * FRAME_US, fileName: 'case_001.mp4' };
const video: VideoIdentity = { sha256: SHA, frameCount: N, durationUs: N * FRAME_US, boundaryUs: synthBoundary };

const names: Record<string, string> = {
  prep: 'Preparation',
  dissect: 'Calot triangle dissection',
  clip: 'Clipping and cutting',
};
const nameOf = (id: string): string | undefined => names[id];
const seg = (phaseId: string, start: number, end: number): Segment => ({ id: `${phaseId}-${start}`, phaseId, start, end });

const SCENARIOS: Record<string, Segment[]> = {
  normal: [seg('prep', 0, 100), seg('dissect', 120, 200)],
  adjacent: [seg('prep', 0, 250), seg('dissect', 250, 400)],
  gap: [seg('prep', 10, 20), seg('clip', 300, 310)],
  endOfVideo: [seg('dissect', 200, 300), seg('clip', 300, N)],
  empty: [],
};

function doc(segments: Segment[], phaseNameOf = nameOf): ExportDocument {
  return buildExportRecords(meta, segments, phaseNameOf, synthBoundary);
}

function parseOk(text: string, nameHint = 'x.phases.csv'): ParsedAnnotation {
  const r = parseAnnotationFile(text, nameHint);
  if (!r.ok) throw new Error(`parse failed: ${JSON.stringify(r.errors)}`);
  return r.file;
}

function parseErrors(text: string, nameHint = 'x.phases.csv'): string[] {
  const r = parseAnnotationFile(text, nameHint);
  expect(r.ok).toBe(false);
  return r.ok ? [] : r.errors.map((e) => e.code);
}

function verifyCodes(parsed: ParsedAnnotation, v: VideoIdentity = video): string[] {
  const r = verifyAgainstVideo(parsed, v);
  return r.ok ? [] : r.problems.map((p) => p.code);
}

const stripMeta = (p: ParsedAnnotation): ExportDocument['records'] =>
  p.records.map(({ phaseId, phaseName, startFrame, endFrame, startUs, endUs }) => ({
    phaseId,
    phaseName,
    startFrame,
    endFrame,
    startUs,
    endUs,
  }));

const HEADER = 'format_version,video_sha256,frame_count,duration_us,phase_id,phase_name,start_frame,end_frame,start_us,end_us';
const row = (cells: (string | number)[]): string => cells.join(',');

// --- CSV primitives -----------------------------------------------------------------------------

describe('csv primitives', () => {
  it('quotes only fields with comma, quote, CR or LF', () => {
    expect(quoteCsvField('plain text')).toBe('plain text');
    expect(quoteCsvField('a,b')).toBe('"a,b"');
    expect(quoteCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(quoteCsvField('a\rb')).toBe('"a\rb"');
    expect(quoteCsvField('a\nb')).toBe('"a\nb"');
    expect(quoteCsvField('')).toBe('');
  });

  it('protects formula-like text losslessly', () => {
    for (const t of ['=1+1', '+1', '-1', '@SUM', '\tx', '\rx', '\nx', "'x", "''x"]) {
      expect(protectFormula(t)).toBe(`'${t}`);
      expect(unprotectFormula(protectFormula(t))).toBe(t);
    }
    for (const t of ['plain', 'a=b', '', '中文', '😀']) {
      expect(protectFormula(t)).toBe(t);
      expect(unprotectFormula(protectFormula(t))).toBe(t);
    }
  });

  it('writes BOM + CRLF and parses it back', () => {
    const rows = [['a', 'b,c'], ['"q"', 'line1\r\nline2'], ['', 'x']];
    const text = writeCsv(rows);
    expect(text.startsWith('\uFEFF')).toBe(true);
    expect(text.endsWith('\r\n')).toBe(true);
    const parsed = parseCsv(text);
    expect(parsed.ok && parsed.rows.map((r) => r.cells)).toEqual(rows);
  });

  it('parses LF, lone CR, missing trailing newline and blank lines', () => {
    const r = parseCsv('a,b\n\nc,"d\ne"\rf,g');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.map((x) => x.cells)).toEqual([['a', 'b'], ['c', 'd\ne'], ['f', 'g']]);
    expect(r.rows.map((x) => x.line)).toEqual([1, 3, 5]);
  });

  it('keeps empty trailing fields and quotes inside unquoted fields', () => {
    const r = parseCsv('a,,\r\nx"y,z\r\n');
    expect(r.ok && r.rows.map((x) => x.cells)).toEqual([['a', '', ''], ['x"y', 'z']]);
  });

  it('reports an unterminated quote with its line', () => {
    expect(parseCsv('a,b\r\nc,"open\r\nmore')).toEqual({ ok: false, error: { code: 'csv_unterminated_quote', line: 2 } });
  });
});

// --- Export format ------------------------------------------------------------------------------

describe('export serialization', () => {
  it('builds records sorted by start with boundary times', () => {
    const d = doc([seg('clip', 300, N), seg('prep', 0, 250), seg('dissect', 250, 300)]);
    expect(d.records.map((r) => [r.startFrame, r.endFrame, r.startUs, r.endUs])).toEqual([
      [0, 250, 0, 10_000_000],
      [250, 300, 10_000_000, 12_000_000],
      [300, N, 12_000_000, 20_000_000],
    ]);
    expect(() => doc([seg('ghost', 0, 1)])).toThrow(/ghost/);
  });

  it('writes the exact CSV layout', () => {
    const text = serializeCsv(doc(SCENARIOS.adjacent));
    expect(text).toBe(
      '\uFEFF' +
        [
          HEADER,
          row([1, SHA, N, 20_000_000, 'prep', 'Preparation', 0, 250, 0, 10_000_000]),
          row([1, SHA, N, 20_000_000, 'dissect', 'Calot triangle dissection', 250, 400, 10_000_000, 16_000_000]),
        ].join('\r\n') +
        '\r\n',
    );
  });

  it('writes the empty-annotation CSV form', () => {
    expect(serializeCsv(doc([]))).toBe(`\uFEFF${HEADER}\r\n${row([1, SHA, N, 20_000_000, '', '', '', '', '', ''])}\r\n`);
  });

  it('writes the exact JSON layout (no BOM, one segment per line)', () => {
    const text = serializeJson(doc(SCENARIOS.adjacent));
    expect(text).toBe(
      [
        '{',
        '  "format": "phase-annotations",',
        '  "format_version": 1,',
        `  "video": {"sha256": "${SHA}", "frame_count": 500, "duration_us": 20000000, "file_name": "case_001.mp4"},`,
        '  "segments": [',
        '    {"phase_id": "prep", "phase_name": "Preparation", "start_frame": 0, "end_frame": 250, "start_us": 0, "end_us": 10000000},',
        '    {"phase_id": "dissect", "phase_name": "Calot triangle dissection", "start_frame": 250, "end_frame": 400, "start_us": 10000000, "end_us": 16000000}',
        '  ]',
        '}',
        '',
      ].join('\n'),
    );
    expect(text.startsWith('\uFEFF')).toBe(false);
    expect(JSON.parse(text).segments).toHaveLength(2);
  });

  it('writes the empty-annotation JSON form', () => {
    const text = serializeJson(doc([]));
    expect(text).toContain('  "segments": []\n');
    expect(JSON.parse(text).segments).toEqual([]);
  });

  it('derives sidecar names from the video stem', () => {
    expect(defaultSidecarName('case_003.mp4', 'csv')).toBe('case_003.phases.csv');
    expect(defaultSidecarName('dir/sub/case.v2.MP4', 'json')).toBe('case.v2.phases.json');
    expect(defaultSidecarName('C:\\videos\\a.m4v', 'csv')).toBe('a.phases.csv');
    expect(videoStem('noext')).toBe('noext');
    expect(videoStem('.hidden')).toBe('.hidden');
  });
});

// --- Round trips --------------------------------------------------------------------------------

describe('round trip', () => {
  for (const [name, segments] of Object.entries(SCENARIOS)) {
    for (const format of ['csv', 'json'] as const) {
      it(`${name} (${format})`, () => {
        const d = doc(segments);
        const text = format === 'csv' ? serializeCsv(d) : serializeJson(d);
        const parsed = parseOk(text, `case_001.phases.${format}`);
        expect(parsed.format).toBe(format);
        expect(parsed.video).toMatchObject({ sha256: SHA, frameCount: N, durationUs: N * FRAME_US });
        expect(stripMeta(parsed)).toEqual(d.records);
        expect(verifyAgainstVideo(parsed, video)).toEqual({ ok: true });
        const { segments: back, phases } = toSegments(parsed);
        expect(back.map((s) => [s.phaseId, s.start, s.end])).toEqual(segments.map((s) => [s.phaseId, s.start, s.end]));
        expect(phases.map((p) => p.name)).toEqual([...new Set(segments.map((s) => names[s.phaseId]))]);
      });
    }
  }

  const TRICKY_NAMES = [
    'Comma, separated',
    'Say "quoted"',
    'Line\r\nbreak',
    'Lone\rCR and lone\nLF',
    '=HYPERLINK("http://x")',
    '+1',
    '-minus',
    '@mention',
    "'apostrophe",
    "''double apostrophe",
    '\tTab first',
    '\nNewline first',
    '膽囊三角解剖（Calot）',
    '🔪 Incision 🩸',
    '  padded  ',
  ];

  for (const format of ['csv', 'json'] as const) {
    it(`preserves tricky phase names and ids (${format})`, () => {
      const tricky: Record<string, string> = {};
      const segments = TRICKY_NAMES.map((n, i) => {
        tricky[`p${i}`] = n;
        return seg(`p${i}`, i * 10, i * 10 + 10);
      });
      const d = doc(segments, (id) => tricky[id]);
      const parsed = parseOk(format === 'csv' ? serializeCsv(d) : serializeJson(d), `f.${format}`);
      expect(parsed.records.map((r) => r.phaseName)).toEqual(TRICKY_NAMES);
      expect(verifyAgainstVideo(parsed, video)).toEqual({ ok: true });
    });
  }

  it('escapes formula-like phase cells in the CSV text', () => {
    const csv = serializeCsv(doc([seg('prep', 0, 1)], () => '=1+1'));
    expect(csv).toContain(",prep,'=1+1,0,1,");
  });

  it('accepts CSV without BOM, with LF only and without a trailing newline', () => {
    const csv = serializeCsv(doc(SCENARIOS.normal));
    const variants = [csv.slice(1), csv.replace(/\r\n/g, '\n'), csv.replace(/\r\n$/, ''), csv.slice(1).replace(/\r\n/g, '\n')];
    for (const v of variants) expect(stripMeta(parseOk(v))).toEqual(doc(SCENARIOS.normal).records);
  });

  it('accepts concatenated CSV files of the same video (repeated header and BOM)', () => {
    const a = serializeCsv(doc([seg('prep', 0, 100)]));
    const b = serializeCsv(doc([seg('clip', 200, 300)]));
    const parsed = parseOk(a + b);
    expect(parsed.records.map((r) => r.startFrame)).toEqual([0, 200]);
    expect(verifyAgainstVideo(parsed, video)).toEqual({ ok: true });
  });

  it('accepts reordered CSV columns and Excel-style CRLF with quoted numbers', () => {
    const text =
      'phase_id,phase_name,start_frame,end_frame,start_us,end_us,format_version,video_sha256,frame_count,duration_us\r\n' +
      `"prep","Preparation","0","10","0","400000","1","${SHA.toUpperCase()}","500","20000000"\r\n`;
    const parsed = parseOk(text);
    expect(parsed.video.sha256).toBe(SHA);
    expect(verifyAgainstVideo(parsed, video)).toEqual({ ok: true });
  });

  it('picks JSON by content regardless of the file name', () => {
    expect(parseOk(serializeJson(doc(SCENARIOS.normal)), 'weird.csv').format).toBe('json');
    expect(parseOk(`\uFEFF${serializeJson(doc(SCENARIOS.normal))}`, 'x').format).toBe('json');
  });
});

// --- Import errors ------------------------------------------------------------------------------

describe('import structural errors', () => {
  const good = (cells: Partial<Record<string, string | number>> = {}): string => {
    const base: Record<string, string | number> = {
      format_version: 1,
      video_sha256: SHA,
      frame_count: N,
      duration_us: 20_000_000,
      phase_id: 'prep',
      phase_name: 'Preparation',
      start_frame: 0,
      end_frame: 10,
      start_us: 0,
      end_us: 400_000,
      ...cells,
    };
    return row(HEADER.split(',').map((h) => base[h] ?? ''));
  };
  const csv = (...rows: string[]): string => [HEADER, ...rows].join('\r\n') + '\r\n';

  it('rejects empty files', () => {
    expect(parseErrors('')).toEqual(['empty_file']);
    expect(parseErrors('\uFEFF \r\n')).toEqual(['empty_file']);
  });

  it('rejects an unknown header and names missing/unexpected columns', () => {
    const r = parseAnnotationFile('start,end,label\r\n0,10,prep\r\n', 'x.csv');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0].code).toBe('unknown_header');
    expect(r.errors[0].params.unexpected).toBe('start, end, label');
    expect(String(r.errors[0].params.missing)).toContain('video_sha256');
    expect(parseErrors(HEADER + ',extra\r\n')).toEqual(['unknown_header']);
    expect(parseErrors(HEADER.replace('phase_name', 'phase_id') + '\r\n')).toEqual(['unknown_header']);
  });

  it('rejects a header without rows', () => {
    expect(parseErrors(`${HEADER}\r\n`)).toEqual(['no_rows']);
  });

  it('rejects mixed video metadata across rows', () => {
    const r = parseAnnotationFile(csv(good(), good({ video_sha256: 'cd'.repeat(32), start_frame: 20, end_frame: 30, start_us: 800_000, end_us: 1_200_000 })), 'x.csv');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([
      { code: 'mixed_video_metadata', params: { line: 3, field: 'video_sha256', expected: SHA, found: 'cd'.repeat(32), firstLine: 2 } },
    ]);
    expect(parseErrors(csv(good(), good({ frame_count: 501 })))).toEqual(['mixed_video_metadata']);
  });

  it('rejects wrong column counts, bad values and unsupported versions, reporting all', () => {
    const codes = parseErrors(
      csv(
        good({ format_version: 2 }),
        '1,2,3',
        good({ video_sha256: 'nothex' }),
        good({ start_frame: 'abc' }),
        good({ phase_id: 'Bad Id' }),
        good({ end_frame: '' }),
      ),
    );
    expect(codes).toEqual(['unsupported_version', 'column_count', 'invalid_value', 'invalid_value', 'invalid_value', 'missing_field']);
  });

  it('reports malformed quoting', () => {
    expect(parseErrors(csv(good()) + '1,"unterminated\r\n')).toEqual(['csv_malformed']);
  });

  it('rejects malformed JSON documents', () => {
    expect(parseErrors('{not json', 'x.json')).toEqual(['invalid_json']);
    expect(parseErrors('[1,2]', 'x.json')).toEqual(['unsupported_format']);
    expect(parseErrors('{"format":"other"}')).toEqual(['unsupported_format']);
    expect(parseErrors('{"format":"phase-annotations","format_version":2}')).toEqual(['unsupported_version']);
    const missing = parseAnnotationFile('{"format":"phase-annotations","format_version":1,"video":{"sha256":"x"}}', 'x.json');
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.errors.map((e) => [e.code, e.params.field])).toEqual([
        ['missing_field', 'video.frame_count'],
        ['missing_field', 'video.duration_us'],
        ['invalid_value', 'video_sha256'],
        ['invalid_value', 'frame_count'],
        ['invalid_value', 'duration_us'],
        ['missing_field', 'segments'],
      ]);
    }
    const d = JSON.parse(serializeJson(doc(SCENARIOS.normal)));
    d.segments[0].start_frame = '0';
    delete d.segments[1].phase_name;
    const r = parseAnnotationFile(JSON.stringify(d), 'x.json');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toEqual([
        { code: 'invalid_value', params: { segment: 1, field: 'start_frame', value: '0' } },
        { code: 'missing_field', params: { segment: 2, field: 'phase_name' } },
      ]);
    }
  });
});

// --- Verification -------------------------------------------------------------------------------

describe('verifyAgainstVideo', () => {
  const parsedOf = (segments: Segment[]): ParsedAnnotation => parseOk(serializeCsv(doc(segments)));

  it('rejects mismatched sha256, frame count and duration (all reported, in order)', () => {
    const parsed = parsedOf(SCENARIOS.normal);
    const other: VideoIdentity = { ...video, sha256: 'cd'.repeat(32), frameCount: N + 1, durationUs: N * FRAME_US + 1 };
    const r = verifyAgainstVideo(parsed, other);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.slice(0, 3)).toEqual([
      { code: 'sha256_mismatch', params: { expected: 'cd'.repeat(32), found: SHA } },
      { code: 'frame_count_mismatch', params: { expected: N + 1, found: N } },
      { code: 'duration_mismatch', params: { expected: N * FRAME_US + 1, found: N * FRAME_US } },
    ]);
  });

  it('rejects boundary times that do not match the video', () => {
    const parsed = parsedOf(SCENARIOS.adjacent);
    const shifted: VideoIdentity = { ...video, boundaryUs: (b) => synthBoundary(b) + (b === 250 ? 1 : 0) };
    const r = verifyAgainstVideo(parsed, shifted);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems).toEqual([
      { code: 'time_mismatch', params: { segment: 1, line: 2, field: 'end_us', expected: 10_000_001, found: 10_000_000 } },
      { code: 'time_mismatch', params: { segment: 2, line: 3, field: 'start_us', expected: 10_000_001, found: 10_000_000 } },
    ]);
  });

  const handCsv = (rows: [string, string, number | string, number | string, number | string, number | string][]): string =>
    [HEADER, ...rows.map((r) => row([1, SHA, N, 20_000_000, ...r]))].join('\r\n');

  it('reports overlaps, out-of-range, empty and non-integer segments together', () => {
    const parsed = parseOk(
      handCsv([
        ['prep', 'Preparation', 0, 100, 0, 4_000_000],
        ['clip', 'Clipping', 90, 120, 3_600_000, 4_800_000],
        ['clip', 'Clipping', 450, 501, 18_000_000, 20_040_000],
        ['clip', 'Clipping', 200, 200, 8_000_000, 8_000_000],
        ['clip', 'Clipping', '10.5', 20, 420_000, 800_000],
        ['prep', 'Preparation', -5, 3, 0, 120_000],
      ]),
    );
    expect(verifyCodes(parsed)).toEqual(['out_of_range', 'empty', 'not_integer', 'out_of_range', 'overlap']);
    const r = verifyAgainstVideo(parsed, video);
    if (!r.ok) expect(r.problems.find((p) => p.code === 'overlap')?.params).toEqual({ a: 1, b: 2, from: 90, to: 100 });
  });

  it('reports non-integer microseconds', () => {
    const parsed = parseOk(handCsv([['prep', 'Preparation', 0, 10, '0.5', 400_000]]));
    expect(verifyCodes(parsed)).toEqual(['not_integer', 'time_mismatch']);
  });

  it('reports inconsistent phase names for the same id', () => {
    const parsed = parseOk(
      handCsv([
        ['prep', 'Preparation', 0, 10, 0, 400_000],
        ['prep', 'Prep', 20, 30, 800_000, 1_200_000],
      ]),
    );
    const r = verifyAgainstVideo(parsed, video);
    expect(r).toEqual({ ok: false, problems: [{ code: 'inconsistent_phase_name', params: { phaseId: 'prep', names: 'Preparation | Prep' } }] });
  });

  it('accepts unsorted JSON segments and sorts them on conversion', () => {
    const d = doc(SCENARIOS.gap);
    const parsed = parseOk(serializeJson({ ...d, records: [...d.records].reverse() }), 'x.json');
    expect(verifyAgainstVideo(parsed, video)).toEqual({ ok: true });
    expect(toSegments(parsed).segments.map((s) => s.start)).toEqual([10, 300]);
  });
});

// --- Real video ---------------------------------------------------------------------------------

interface ManifestEntry {
  frame_count: number;
  pts_us: number[];
  sha256: string;
}

describe('export times match ffprobe for real fixture videos', () => {
  const dir = path.resolve('tests/fixtures/videos');
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Record<string, ManifestEntry>;

  for (const name of ['cfr25_bframes.mp4', 'ntsc2997.mp4', 'vfr_mixed.mp4', 'tiny3.mp4']) {
    it(name, async () => {
      const m = manifest[name];
      const index = await indexMp4(new BufferByteReader(new Uint8Array(readFileSync(path.join(dir, name)))));
      const n = index.frameCount;
      expect(n).toBe(m.frame_count);
      const cut1 = Math.floor(n / 3);
      const cut2 = Math.floor((2 * n) / 3);
      const segments: Segment[] = [
        seg('prep', 0, Math.max(1, cut1)),
        ...(cut2 > cut1 ? [seg('dissect', cut1, cut2)] : []),
        seg('clip', Math.max(cut2, 1), n),
      ].filter((s) => s.end > s.start);
      const bUs = (b: number): number => indexBoundaryUs(index, b);
      const realMeta: VideoMeta = { sha256: m.sha256, frameCount: n, durationUs: index.durationUs, fileName: name };
      const d = buildExportRecords(realMeta, segments, nameOf, bUs);

      for (const r of d.records) {
        expect(r.startUs).toBe(m.pts_us[r.startFrame]);
        expect(r.endUs).toBe(r.endFrame === n ? index.durationUs : m.pts_us[r.endFrame]);
      }
      expect(d.records.at(-1)?.endFrame).toBe(n);
      expect(index.durationUs).toBeGreaterThan(m.pts_us[n - 1]);
      if (!name.startsWith('vfr')) {
        // constant frame rate: duration = last pts + one frame interval (±1 µs rounding)
        const step = m.pts_us[1] - m.pts_us[0];
        expect(Math.abs(index.durationUs - (m.pts_us[n - 1] + step))).toBeLessThanOrEqual(1);
      }

      const identity: VideoIdentity = { sha256: m.sha256, frameCount: n, durationUs: index.durationUs, boundaryUs: bUs };
      for (const text of [serializeCsv(d), serializeJson(d)]) {
        const parsed = parseOk(text, name);
        expect(verifyAgainstVideo(parsed, identity)).toEqual({ ok: true });
      }
      const other = manifest['same_name_b.mp4'];
      const mismatch = verifyAgainstVideo(parseOk(serializeCsv(d)), { ...identity, sha256: other.sha256 });
      expect(mismatch.ok).toBe(false);
    });
  }
});
