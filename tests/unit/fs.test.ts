import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanFolder, openEntry, mapLimited } from '../../src/fs/scan';
import { sortEntries } from '../../src/fs/sort';
import { isSidecarFor, naturalCompare, stemOf } from '../../src/fs/names';
import { writeTextFile, readTextIfExists, ensurePermission, queryPermission } from '../../src/fs/write';
import { requestSourceFolder, findFileInDir, sameEntry } from '../../src/fs/sourceFolder';
import { resolveDrop, captureDrop, type DropResult } from '../../src/fs/drop';
import { pickFolder, pickVideoFile, pickAnnotationFile, pickExportFolder, supportsFileSystemAccess } from '../../src/fs/pickers';
import { handleDir, type DirRef, type VideoEntry } from '../../src/fs/types';
import { virtualDirFromFiles } from '../../src/fs/virtual';
import { DEFAULT_MTIME, FakeFs, fakeFile, fileWithRelPath, type FakeDirHandle } from './helpers/fakeFs';

afterEach(() => {
  vi.unstubAllGlobals();
});

const paths = (entries: readonly VideoEntry[]): string[] => entries.map((e) => e.relPath);
const sidecarNames = (entries: readonly VideoEntry[], relPath: string): string[] =>
  entries.find((e) => e.relPath === relPath)?.sidecars.map((s) => s.name) ?? [];

function rootOf(fs: FakeFs): DirRef {
  return handleDir(fs.root);
}

function domError(name: string): DOMException {
  return new DOMException(name, name);
}

describe('names', () => {
  it('derives stems from the final extension', () => {
    expect(stemOf('case.mp4')).toBe('case');
    expect(stemOf('case.v2.MP4')).toBe('case.v2');
    expect(stemOf('noext')).toBe('noext');
  });

  it('matches sidecars by stem followed by a separator', () => {
    for (const name of ['case.csv', 'case.phases.csv', 'case_annotations.json', 'case-v2.json', 'case notes.csv', 'CASE.PHASES.CSV', 'Case.Json']) {
      expect(isSidecarFor('case', name), name).toBe(true);
    }
    for (const name of ['case2.csv', 'case.txt', 'case.mp4', 'cas.csv', '.case.csv', 'xcase.csv', 'case']) {
      expect(isSidecarFor('case', name), name).toBe(false);
    }
  });

  it('compares naturally and case-insensitively', () => {
    const sorted = ['case10', 'Case2', 'case1', 'case2b'].sort(naturalCompare);
    expect(sorted).toEqual(['case1', 'Case2', 'case2b', 'case10']);
  });
});

describe('scanFolder (handles)', () => {
  const tree = {
    'b10.mp4': 'b10',
    'b2.MP4': 'b2',
    'clip.m4v': 'clip',
    'readme.txt': 'x',
    '.hidden.mp4': 'h',
    '.git': { 'inside.mp4': 'x' },
    node_modules: { 'pkg.mp4': 'x' },
    day1: {
      'case.mp4': fakeFile('0123456789', 111),
      'case.csv': 'csv',
      'case.phases.csv': 'p',
      'case_annotations.json': '{}',
      'case2.csv': 'not mine',
      'case.txt': 'nope',
      '.case.csv': 'hidden',
      nested: { deeper: { 'deep.mp4': 'deep' } },
    },
    Day2: { 'case.mp4': fakeFile('abc', 222), 'case.phases.json': '{"x":1}' },
  };

  it('finds videos recursively with forward-slash relative paths in natural order', async () => {
    const entries = await scanFolder(rootOf(new FakeFs('root', tree)));
    expect(paths(entries)).toEqual(['b2.MP4', 'b10.mp4', 'clip.m4v', 'day1/case.mp4', 'day1/nested/deeper/deep.mp4', 'Day2/case.mp4']);
  });

  it('skips hidden entries and node_modules', async () => {
    const entries = await scanFolder(rootOf(new FakeFs('root', tree)));
    expect(paths(entries).some((p) => p.includes('.git') || p.includes('node_modules') || p.includes('.hidden'))).toBe(false);
  });

  it('collects sidecars in the same directory only', async () => {
    const entries = await scanFolder(rootOf(new FakeFs('root', tree)));
    expect([...sidecarNames(entries, 'day1/case.mp4')].sort()).toEqual(['case.csv', 'case.phases.csv', 'case_annotations.json']);
    expect(sidecarNames(entries, 'Day2/case.mp4')).toEqual(['case.phases.json']);
    expect(sidecarNames(entries, 'day1/nested/deeper/deep.mp4')).toEqual([]);
    const sc = entries.find((e) => e.relPath === 'Day2/case.mp4')?.sidecars[0];
    expect(sc).toMatchObject({ relPath: 'Day2/case.phases.json', format: 'json', size: 7, lastModified: DEFAULT_MTIME });
    expect(await sc?.readText()).toBe('{"x":1}');
  });

  it('keeps same-name videos in different folders distinct', async () => {
    const entries = await scanFolder(rootOf(new FakeFs('root', tree)));
    const cases = entries.filter((e) => e.name === 'case.mp4');
    expect(cases.map((e) => e.id)).toEqual(['day1/case.mp4', 'Day2/case.mp4']);
    expect(cases.map((e) => [e.size, e.lastModified])).toEqual([[10, 111], [3, 222]]);
    expect(cases.map((e) => e.dir.path)).toEqual([['day1'], ['Day2']]);
    for (const e of cases) {
      expect(e.fileHandle).not.toBeNull();
      expect(e.file).toBeNull();
      expect(e.stem).toBe('case');
      expect(e.dir.canWrite()).toBe(true);
    }
  });

  it('gives a sidecar to the video with the longest matching stem', async () => {
    const fs = new FakeFs('root', { 'case.mp4': 'a', 'case_2.mp4': 'b', 'case_2.phases.csv': 'x', 'case.phases.csv': 'y', 'case_notes.csv': 'z' });
    const entries = await scanFolder(rootOf(fs));
    expect([...sidecarNames(entries, 'case.mp4')].sort()).toEqual(['case.phases.csv', 'case_notes.csv']);
    expect(sidecarNames(entries, 'case_2.mp4')).toEqual(['case_2.phases.csv']);
  });

  it('reads sidecar text fresh from disk', async () => {
    const fs = new FakeFs('root', { 'v.mp4': 'a', 'v.csv': 'old' });
    const [entry] = await scanFolder(rootOf(fs));
    fs.file('v.csv').data = new TextEncoder().encode('new');
    expect(await entry.sidecars[0].readText()).toBe('new');
  });

  it('limits concurrent getFile calls', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) files[`v${i}.mp4`] = 'x';
    const fs = new FakeFs('root', files);
    fs.getFileDelayMs = 3;
    const entries = await scanFolder(rootOf(fs));
    expect(entries).toHaveLength(30);
    expect(fs.getFileCalls).toBe(30);
    expect(fs.maxActiveGetFile).toBeGreaterThan(1);
    expect(fs.maxActiveGetFile).toBeLessThanOrEqual(8);
  });

  it('reports progress and skips unreadable subdirectories', async () => {
    const fs = new FakeFs('root', { 'a.mp4': 'a', locked: { 'b.mp4': 'b' } });
    const locked = fs.dir('locked');
    locked.values = async function* () {
      yield* [];
      throw domError('NotAllowedError');
    };
    const progress = vi.fn();
    const skipped: string[] = [];
    const entries = await scanFolder(rootOf(fs), { onProgress: progress, onSkip: (p) => skipped.push(p) });
    expect(paths(entries)).toEqual(['a.mp4']);
    expect(skipped).toEqual(['locked']);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'listing' }));
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'reading', filesRead: 1, filesToRead: 1 }));
  });

  it('skips files that disappear before they are read', async () => {
    const fs = new FakeFs('root', { 'a.mp4': 'a', 'gone.mp4': 'b' });
    fs.file('gone.mp4').getFile = () => Promise.reject(domError('NotFoundError'));
    const skipped: string[] = [];
    const entries = await scanFolder(rootOf(fs), { onSkip: (p) => skipped.push(p) });
    expect(paths(entries)).toEqual(['a.mp4']);
    expect(skipped).toEqual(['gone.mp4']);
  });

  it('falls back to entries() when values() is missing', async () => {
    const fs = new FakeFs('root', { 'a.mp4': 'a' });
    Object.defineProperty(fs.root, 'values', { value: undefined });
    expect(paths(await scanFolder(rootOf(fs)))).toEqual(['a.mp4']);
  });

  it('rejects with AbortError when aborted', async () => {
    const fs = new FakeFs('root', { 'a.mp4': 'a', sub: { 'b.mp4': 'b' } });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(scanFolder(rootOf(fs), { signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('opens entries with a fresh File and their relative path', async () => {
    const fs = new FakeFs('root', { sub: { 'a.mp4': 'abc' } });
    const [entry] = await scanFolder(rootOf(fs));
    fs.file('sub/a.mp4').data = new TextEncoder().encode('abcdef');
    const source = await openEntry(entry);
    expect(source.file.size).toBe(6);
    expect(source).toMatchObject({ name: 'a.mp4', relPath: 'sub/a.mp4', parent: entry.dir, fileHandle: entry.fileHandle });
  });
});

describe('scanFolder (virtual dirs)', () => {
  const files = [
    fileWithRelPath('videos/b10.mp4', 'b10'),
    fileWithRelPath('videos/b2.mp4', 'b2'),
    fileWithRelPath('videos/day1/case.mp4', '0123', 5),
    fileWithRelPath('videos/day1/case.phases.csv', 'csv'),
    fileWithRelPath('videos/day2/case.mp4', 'xy', 6),
    fileWithRelPath('videos/day2/case_other.json', '{}'),
    fileWithRelPath('videos/.cache/x.mp4', 'x'),
    fileWithRelPath('videos/node_modules/y.mp4', 'y'),
    fileWithRelPath('videos/.DS_Store', ''),
  ];

  it('builds a read-only tree from webkitRelativePath', () => {
    const root = virtualDirFromFiles(files);
    expect(root).not.toBeNull();
    expect(root?.name).toBe('videos');
    expect(root?.kind).toBe('virtual');
    expect(root?.canWrite()).toBe(false);
    expect([...(root?.node.dirs.keys() ?? [])]).toEqual(['day1', 'day2']);
    expect(virtualDirFromFiles([])).toBeNull();
  });

  it('scans like a handle-backed folder', async () => {
    const root = virtualDirFromFiles(files) as DirRef;
    const entries = await scanFolder(root);
    expect(paths(entries)).toEqual(['b2.mp4', 'b10.mp4', 'day1/case.mp4', 'day2/case.mp4']);
    const day1 = entries[2];
    expect(day1.fileHandle).toBeNull();
    expect(day1.file?.name).toBe('case.mp4');
    expect([day1.size, day1.lastModified]).toEqual([4, 5]);
    expect(sidecarNames(entries, 'day1/case.mp4')).toEqual(['case.phases.csv']);
    expect(sidecarNames(entries, 'day2/case.mp4')).toEqual(['case_other.json']);
    expect(await day1.sidecars[0].readText()).toBe('csv');
    expect((await openEntry(day1)).file).toBe(day1.file);
  });
});

describe('sortEntries', () => {
  const e = (relPath: string, size: number, lastModified: number) => ({ relPath, size, lastModified });
  const list = [e('case10.mp4', 5, 30), e('Case2.mp4', 9, 10), e('a/z.mp4', 5, 20), e('case1.mp4', 1, 30)];

  it('sorts by name naturally, case-insensitively, both directions', () => {
    expect(sortEntries(list, 'name', 'asc').map((x) => x.relPath)).toEqual(['a/z.mp4', 'case1.mp4', 'Case2.mp4', 'case10.mp4']);
    expect(sortEntries(list, 'name', 'desc').map((x) => x.relPath)).toEqual(['case10.mp4', 'Case2.mp4', 'case1.mp4', 'a/z.mp4']);
  });

  it('sorts by mtime and size with a path tiebreak', () => {
    expect(sortEntries(list, 'mtime', 'asc').map((x) => x.relPath)).toEqual(['Case2.mp4', 'a/z.mp4', 'case1.mp4', 'case10.mp4']);
    expect(sortEntries(list, 'mtime', 'desc').map((x) => x.relPath)).toEqual(['case1.mp4', 'case10.mp4', 'a/z.mp4', 'Case2.mp4']);
    expect(sortEntries(list, 'size', 'desc').map((x) => x.relPath)).toEqual(['Case2.mp4', 'a/z.mp4', 'case10.mp4', 'case1.mp4']);
  });

  it('does not mutate its input', () => {
    const copy = [...list];
    sortEntries(list, 'size', 'asc');
    expect(list).toEqual(copy);
  });
});

describe('mapLimited', () => {
  it('preserves order', async () => {
    const out = await mapLimited([3, 1, 2], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      return n * 10;
    });
    expect(out).toEqual([30, 10, 20]);
  });
});

describe('permissions', () => {
  it('queries and requests only when allowed', async () => {
    const fs = new FakeFs('root');
    fs.permission.readwrite = 'prompt';
    expect(await queryPermission(fs.root, 'readwrite')).toBe('prompt');
    expect(await ensurePermission(fs.root, 'readwrite')).toBe(false);
    expect(fs.requestCalls).toBe(0);
    expect(await ensurePermission(fs.root, 'readwrite', { request: true })).toBe(true);
    expect(fs.requestCalls).toBe(1);
  });

  it('treats handles without the permission API as granted', async () => {
    const bare = { kind: 'directory', name: 'x' } as unknown as FileSystemHandle;
    expect(await queryPermission(bare, 'readwrite')).toBe('granted');
  });

  it('reports false when the request throws (no user gesture)', async () => {
    const fs = new FakeFs('root');
    fs.permission.readwrite = 'prompt';
    fs.requestError = domError('SecurityError');
    expect(await ensurePermission(fs.root, 'readwrite', { request: true })).toBe(false);
  });
});

describe('writeTextFile', () => {
  it('creates and overwrites files', async () => {
    const fs = new FakeFs('root', { 'old.csv': 'previous content' });
    expect(await writeTextFile(rootOf(fs), 'new.csv', '﻿a,b\r\n')).toEqual({ ok: true });
    expect(fs.readText('new.csv')).toBe('﻿a,b\r\n');
    expect(await writeTextFile(rootOf(fs), 'old.csv', 'short')).toEqual({ ok: true });
    expect(fs.readText('old.csv')).toBe('short');
  });

  it('reports permission_denied without prompting outside a gesture', async () => {
    const fs = new FakeFs('root');
    fs.permission.readwrite = 'prompt';
    const res = await writeTextFile(rootOf(fs), 'x.csv', 'x');
    expect(res).toMatchObject({ ok: false, reason: 'permission_denied' });
    expect(fs.requestCalls).toBe(0);
    expect(fs.lookup('x.csv')).toBeNull();
  });

  it('prompts when requested and honours the answer', async () => {
    const fs = new FakeFs('root');
    fs.permission.readwrite = 'prompt';
    fs.requestResult = 'denied';
    expect(await writeTextFile(rootOf(fs), 'x.csv', 'x', { request: true })).toMatchObject({ ok: false, reason: 'permission_denied' });
    fs.permission.readwrite = 'prompt';
    fs.requestResult = 'granted';
    expect(await writeTextFile(rootOf(fs), 'x.csv', 'x', { request: true })).toEqual({ ok: true });
    expect(fs.requestCalls).toBe(2);
  });

  it.each([
    ['write', 'QuotaExceededError', 'no_space'],
    ['write', 'NotAllowedError', 'permission_denied'],
    ['close', 'SecurityError', 'permission_denied'],
    ['createWritable', 'NotFoundError', 'not_found'],
    ['close', 'InvalidStateError', 'unknown'],
  ] as const)('maps %s failure %s to %s and leaves the old file intact', async (stage, name, reason) => {
    const fs = new FakeFs('root', { 'a.csv': 'original' });
    fs.failures[stage] = domError(name);
    const res = await writeTextFile(rootOf(fs), 'a.csv', 'replacement');
    expect(res).toMatchObject({ ok: false, reason, errorName: name });
    expect(fs.readText('a.csv')).toBe('original');
    expect(fs.abortCount).toBe(stage === 'createWritable' ? 0 : 1);
  });

  it('maps non-DOM errors to unknown', async () => {
    const fs = new FakeFs('root');
    fs.failures.write = new TypeError('boom');
    expect(await writeTextFile(rootOf(fs), 'a.csv', 'x')).toMatchObject({ ok: false, reason: 'unknown', message: 'boom' });
    expect(fs.abortCount).toBe(1);
  });

  it('removes a newly created file when the write fails', async () => {
    const fs = new FakeFs('root');
    fs.failures.write = domError('QuotaExceededError');
    await writeTextFile(rootOf(fs), 'fresh.csv', 'x');
    expect(fs.lookup('fresh.csv')).toBeNull();
  });

  it('reports not_found when the directory disappeared', async () => {
    const fs = new FakeFs('root');
    fs.failures.getFileHandle = domError('NotFoundError');
    expect(await writeTextFile(rootOf(fs), 'a.csv', 'x')).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('refuses virtual dirs and invalid names', async () => {
    const vroot = virtualDirFromFiles([fileWithRelPath('v/a.mp4', 'a')]) as DirRef;
    expect(await writeTextFile(vroot, 'a.csv', 'x')).toMatchObject({ ok: false, reason: 'unsupported' });
    const fs = new FakeFs('root');
    for (const bad of ['', '..', 'a/b.csv', 'a\\b.csv']) {
      expect(await writeTextFile(rootOf(fs), bad, 'x')).toMatchObject({ ok: false, reason: 'unknown' });
    }
  });
});

describe('readTextIfExists', () => {
  it('reads existing files and returns null for missing ones', async () => {
    const fs = new FakeFs('root', { 'a.csv': 'hello', sub: {} });
    expect(await readTextIfExists(rootOf(fs), 'a.csv')).toBe('hello');
    expect(await readTextIfExists(rootOf(fs), 'missing.csv')).toBeNull();
    expect(await readTextIfExists(rootOf(fs), 'sub')).toBeNull();
    const vroot = virtualDirFromFiles([fileWithRelPath('v/a.csv', 'virt')]) as DirRef;
    expect(await readTextIfExists(vroot, 'a.csv')).toBe('virt');
    expect(await readTextIfExists(vroot, 'b.csv')).toBeNull();
  });
});

describe('requestSourceFolder', () => {
  function stubPicker(result: FakeDirHandle | Error): ReturnType<typeof vi.fn> {
    const picker = vi.fn((_opts: unknown) => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)));
    vi.stubGlobal('showDirectoryPicker', picker);
    return picker;
  }

  const tree = { a: { b: { 'case.mp4': 'v', 'case.phases.csv': 'x' } }, other: {} };

  it('walks down from an ancestor to the direct parent', async () => {
    const fs = new FakeFs('root', tree);
    const video = fs.file('a/b/case.mp4');
    const picker = stubPicker(fs.root);
    const res = await requestSourceFolder(video);
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ startIn: video, mode: 'readwrite' }));
    expect(res).toMatchObject({ ok: true, walked: ['a', 'b'], writable: true });
    if (!res.ok) throw new Error('expected ok');
    expect(res.dir.handle).toBe(fs.dir('a/b'));
    expect(res.dir.path).toEqual([]);
    expect(await readTextIfExists(res.dir, 'case.phases.csv')).toBe('x');
  });

  it('accepts the direct parent', async () => {
    const fs = new FakeFs('root', tree);
    stubPicker(fs.dir('a/b'));
    expect(await requestSourceFolder(fs.file('a/b/case.mp4'))).toMatchObject({ ok: true, walked: [] });
  });

  it('reports not_containing for an unrelated folder', async () => {
    const fs = new FakeFs('root', tree);
    stubPicker(fs.dir('other'));
    expect(await requestSourceFolder(fs.file('a/b/case.mp4'))).toEqual({ ok: false, reason: 'not_containing' });
    const elsewhere = new FakeFs('elsewhere', { a: { b: { 'case.mp4': 'v' } } });
    stubPicker(elsewhere.root);
    expect(await requestSourceFolder(fs.file('a/b/case.mp4'))).toEqual({ ok: false, reason: 'not_containing' });
  });

  it('reports writable=false without readwrite permission', async () => {
    const fs = new FakeFs('root', tree);
    fs.permission.readwrite = 'prompt';
    stubPicker(fs.root);
    expect(await requestSourceFolder(fs.file('a/b/case.mp4'))).toMatchObject({ ok: true, writable: false });
  });

  it('handles cancel, errors and missing API', async () => {
    const fs = new FakeFs('root', tree);
    const video = fs.file('a/b/case.mp4');
    expect(await requestSourceFolder(video)).toEqual({ ok: false, reason: 'unsupported' });
    stubPicker(domError('AbortError'));
    expect(await requestSourceFolder(video)).toEqual({ ok: false, reason: 'cancelled' });
    stubPicker(domError('SecurityError'));
    expect(await requestSourceFolder(video)).toMatchObject({ ok: false, reason: 'error' });
  });

  it('finds files and compares entries', async () => {
    const fs = new FakeFs('root', tree);
    const dir = handleDir(fs.dir('a/b'));
    const found = await findFileInDir(dir, 'case.mp4');
    expect(found).toBe(fs.file('a/b/case.mp4'));
    expect(await findFileInDir(dir, 'nope.mp4')).toBeNull();
    expect(await sameEntry(fs.file('a/b/case.mp4'), fs.file('a/b/case.mp4'))).toBe(true);
    expect(await sameEntry(fs.file('a/b/case.mp4'), fs.file('a/b/case.phases.csv'))).toBe(false);
    expect(await sameEntry(fs.dir('a'), fs.file('a/b/case.mp4'))).toBe(false);
  });
});

describe('pickers', () => {
  it('detects File System Access support', () => {
    expect(supportsFileSystemAccess()).toBe(false);
    vi.stubGlobal('showOpenFilePicker', vi.fn());
    vi.stubGlobal('showDirectoryPicker', vi.fn());
    expect(supportsFileSystemAccess()).toBe(true);
  });

  it('picks a writable folder and returns null on cancel', async () => {
    const fs = new FakeFs('videos', { 'a.mp4': 'a' });
    const picker = vi.fn().mockResolvedValueOnce(fs.root).mockRejectedValueOnce(domError('AbortError'));
    vi.stubGlobal('showDirectoryPicker', picker);
    const dir = await pickFolder();
    expect(picker).toHaveBeenCalledWith({ mode: 'readwrite', id: 'videos' });
    expect(dir).toMatchObject({ kind: 'handle', name: 'videos', path: [] });
    expect(await pickFolder()).toBeNull();
  });

  it('propagates unexpected picker errors', async () => {
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockRejectedValue(domError('InvalidStateError')));
    await expect(pickExportFolder()).rejects.toMatchObject({ name: 'InvalidStateError' });
  });

  it('picks a video file with its handle', async () => {
    const fs = new FakeFs('root', { 'case.mp4': 'abc' });
    const picker = vi.fn().mockResolvedValueOnce([fs.file('case.mp4')]).mockRejectedValueOnce(domError('AbortError'));
    vi.stubGlobal('showOpenFilePicker', picker);
    const source = await pickVideoFile();
    expect(source).toMatchObject({ name: 'case.mp4', fileHandle: fs.file('case.mp4'), parent: null, relPath: null });
    expect(source?.file.size).toBe(3);
    expect(await pickVideoFile()).toBeNull();
  });

  it('picks an annotation file', async () => {
    const fs = new FakeFs('root', { 'case.csv': 'x,y' });
    vi.stubGlobal('showOpenFilePicker', vi.fn().mockResolvedValue([fs.file('case.csv')]));
    expect(await (await pickAnnotationFile())?.text()).toBe('x,y');
  });

  it('returns null for export folders when unsupported', async () => {
    expect(await pickExportFolder()).toBeNull();
  });
});

describe('drop', () => {
  interface FakeItemSpec {
    handle?: FileSystemHandle | null;
    entry?: FileSystemEntry | null;
    file?: File | null;
  }

  function dataTransfer(items: FakeItemSpec[], files: File[] = []): DataTransfer {
    const dtItems = items.map((spec) => ({
      kind: 'file',
      ...(spec.handle !== undefined ? { getAsFileSystemHandle: () => Promise.resolve(spec.handle ?? null) } : {}),
      webkitGetAsEntry: () => spec.entry ?? null,
      getAsFile: () => spec.file ?? null,
    }));
    return { items: dtItems, files } as unknown as DataTransfer;
  }

  /** Minimal legacy Entries API tree; readEntries returns batches of 2 to exercise looping. */
  function dirEntry(name: string, children: FileSystemEntry[]): FileSystemDirectoryEntry {
    return {
      name,
      isDirectory: true,
      isFile: false,
      createReader: () => {
        let pos = 0;
        return {
          readEntries: (ok: (e: FileSystemEntry[]) => void) => {
            const batch = children.slice(pos, pos + 2);
            pos += batch.length;
            queueMicrotask(() => ok(batch));
          },
        };
      },
    } as unknown as FileSystemDirectoryEntry;
  }

  function fileEntry(file: File): FileSystemFileEntry {
    return { name: file.name, isDirectory: false, isFile: true, file: (ok: (f: File) => void) => ok(file) } as unknown as FileSystemFileEntry;
  }

  const handleDrop = (dt: DataTransfer): Promise<DropResult> => resolveDrop(captureDrop(dt));

  it('returns a folder for a dropped directory handle', async () => {
    const fs = new FakeFs('dropped', { 'a.mp4': 'a' });
    const res = await handleDrop(dataTransfer([{ handle: fs.file('a.mp4') }, { handle: fs.root }]));
    expect(res.kind).toBe('folder');
    if (res.kind === 'folder') expect(res.root).toMatchObject({ kind: 'handle', name: 'dropped' });
  });

  it('returns a file source for a dropped video handle', async () => {
    const fs = new FakeFs('r', { 'notes.txt': 'n', 'case.mp4': 'abc' });
    const res = await handleDrop(dataTransfer([{ handle: fs.file('notes.txt') }, { handle: fs.file('case.mp4') }]));
    expect(res).toMatchObject({ kind: 'file', source: { name: 'case.mp4', fileHandle: fs.file('case.mp4') } });
  });

  it('builds a virtual folder from webkitGetAsEntry', async () => {
    const tree = dirEntry('drop', [
      fileEntry(new File(['1'], 'a.mp4')),
      fileEntry(new File(['2'], 'a.csv')),
      dirEntry('sub', [fileEntry(new File(['3'], 'b.mp4'))]),
      dirEntry('node_modules', [fileEntry(new File(['4'], 'c.mp4'))]),
      fileEntry(new File(['5'], '.hidden.mp4')),
    ]);
    const res = await handleDrop(dataTransfer([{ entry: tree }]));
    if (res.kind !== 'folder') throw new Error(`expected folder, got ${res.kind}`);
    expect(res.root.kind).toBe('virtual');
    const entries = await scanFolder(res.root);
    expect(paths(entries)).toEqual(['a.mp4', 'sub/b.mp4']);
    expect(sidecarNames(entries, 'a.mp4')).toEqual(['a.csv']);
  });

  it('falls back to entries and plain files when handles are unavailable', async () => {
    const video = new File(['abc'], 'clip.M4V');
    expect(await handleDrop(dataTransfer([{ handle: null, entry: fileEntry(video) }]))).toMatchObject({ kind: 'file', source: { file: video, fileHandle: null } });
    expect(await handleDrop(dataTransfer([], [video]))).toMatchObject({ kind: 'file', source: { file: video } });
  });

  it('rejects empty and non-video drops', async () => {
    expect(await handleDrop(dataTransfer([]))).toEqual({ kind: 'unsupported', reason: 'empty' });
    expect(await handleDrop(dataTransfer([{ file: new File(['x'], 'notes.csv') }]))).toEqual({ kind: 'unsupported', reason: 'not_video' });
  });
});
