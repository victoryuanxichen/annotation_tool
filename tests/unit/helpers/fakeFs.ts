/**
 * In-memory subset of the File System Access API for unit tests (node env): directory/file
 * handles with iteration, lookup/creation, removal, resolve, isSameEntry, permissions with a
 * configurable state, and createWritable with injectable failures.
 */

export type FakeContent = string | Uint8Array;

export class FakeFileSpec {
  constructor(
    readonly content: FakeContent,
    readonly lastModified: number,
  ) {}
}

/** A file with an explicit modification time (plain strings get `DEFAULT_MTIME`). */
export function fakeFile(content: FakeContent, lastModified: number): FakeFileSpec {
  return new FakeFileSpec(content, lastModified);
}

export interface FakeTree {
  [name: string]: FakeContent | FakeFileSpec | FakeTree;
}

export const DEFAULT_MTIME = 1_700_000_000_000;

type PermissionMode = 'read' | 'readwrite';

export interface WriteFailures {
  getFileHandle?: Error;
  createWritable?: Error;
  write?: Error;
  close?: Error;
}

/** Shared controller: permission state, failure injection and instrumentation. */
export class FakeFs {
  readonly root: FakeDirHandle;
  permission: Record<PermissionMode, PermissionState> = { read: 'granted', readwrite: 'granted' };
  /** Result of requestPermission (also becomes the new state). */
  requestResult: PermissionState = 'granted';
  /** Make requestPermission throw (e.g. SecurityError without a user gesture). */
  requestError: Error | null = null;
  requestCalls = 0;
  failures: WriteFailures = {};
  abortCount = 0;
  getFileCalls = 0;
  getFileDelayMs = 0;
  private activeGetFile = 0;
  maxActiveGetFile = 0;

  constructor(rootName: string, tree: FakeTree = {}) {
    this.root = new FakeDirHandle(this, rootName);
    this.root.populate(tree);
  }

  async trackGetFile<T>(fn: () => T): Promise<T> {
    this.getFileCalls++;
    this.activeGetFile++;
    this.maxActiveGetFile = Math.max(this.maxActiveGetFile, this.activeGetFile);
    try {
      if (this.getFileDelayMs > 0) await new Promise((r) => setTimeout(r, this.getFileDelayMs));
      else await Promise.resolve();
      return fn();
    } finally {
      this.activeGetFile--;
    }
  }

  /** Looks up a handle by forward-slash path relative to the root. */
  lookup(path: string): FakeFileHandle | FakeDirHandle | null {
    let node: FakeFileHandle | FakeDirHandle = this.root;
    for (const seg of path.split('/').filter(Boolean)) {
      if (!(node instanceof FakeDirHandle)) return null;
      const next = node.children.get(seg);
      if (!next) return null;
      node = next;
    }
    return node;
  }

  dir(path: string): FakeDirHandle {
    const h = this.lookup(path);
    if (!(h instanceof FakeDirHandle)) throw new Error(`not a directory: ${path}`);
    return h;
  }

  file(path: string): FakeFileHandle {
    const h = this.lookup(path);
    if (!(h instanceof FakeFileHandle)) throw new Error(`not a file: ${path}`);
    return h;
  }

  readText(path: string): string | null {
    const h = this.lookup(path);
    return h instanceof FakeFileHandle ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(h.data) : null;
  }
}

function domError(name: string, message = name): DOMException {
  return new DOMException(message, name);
}

function toBytes(content: FakeContent): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content;
}

abstract class FakeHandleBase {
  constructor(
    readonly fs: FakeFs,
    readonly name: string,
  ) {}

  isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return Promise.resolve(other === (this as unknown));
  }

  queryPermission(descriptor?: { mode?: PermissionMode }): Promise<PermissionState> {
    return Promise.resolve(this.fs.permission[descriptor?.mode ?? 'read']);
  }

  requestPermission(descriptor?: { mode?: PermissionMode }): Promise<PermissionState> {
    this.fs.requestCalls++;
    if (this.fs.requestError) return Promise.reject(this.fs.requestError);
    this.fs.permission[descriptor?.mode ?? 'read'] = this.fs.requestResult;
    return Promise.resolve(this.fs.requestResult);
  }
}

class FakeWritable {
  private chunks: Uint8Array[] = [];
  private state: 'open' | 'closed' | 'aborted' = 'open';

  constructor(private readonly target: FakeFileHandle) {}

  write(data: FakeContent): Promise<void> {
    if (this.state !== 'open') return Promise.reject(new TypeError('stream is not writable'));
    if (this.target.fs.failures.write) return Promise.reject(this.target.fs.failures.write);
    this.chunks.push(toBytes(data));
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (this.state !== 'open') return Promise.reject(new TypeError('stream is not writable'));
    if (this.target.fs.failures.close) return Promise.reject(this.target.fs.failures.close);
    this.state = 'closed';
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const data = new Uint8Array(total);
    let off = 0;
    for (const c of this.chunks) {
      data.set(c, off);
      off += c.length;
    }
    this.target.data = data;
    this.target.lastModified = Date.now();
    return Promise.resolve();
  }

  abort(): Promise<void> {
    this.state = 'aborted';
    this.target.fs.abortCount++;
    return Promise.resolve();
  }
}

export class FakeFileHandle extends FakeHandleBase implements FileSystemFileHandle {
  readonly kind = 'file' as const;

  constructor(
    fs: FakeFs,
    name: string,
    public data: Uint8Array,
    public lastModified: number,
  ) {
    super(fs, name);
  }

  getFile(): Promise<File> {
    return this.fs.trackGetFile(() => new File([this.data.slice()], this.name, { lastModified: this.lastModified }));
  }

  createWritable(): Promise<FileSystemWritableFileStream> {
    if (this.fs.failures.createWritable) return Promise.reject(this.fs.failures.createWritable);
    return Promise.resolve(new FakeWritable(this) as unknown as FileSystemWritableFileStream);
  }

  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle> {
    return Promise.reject(domError('NotSupportedError'));
  }
}

export class FakeDirHandle extends FakeHandleBase implements FileSystemDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly children = new Map<string, FakeFileHandle | FakeDirHandle>();

  populate(tree: FakeTree): void {
    for (const [name, value] of Object.entries(tree)) {
      if (typeof value === 'string' || value instanceof Uint8Array) {
        this.children.set(name, new FakeFileHandle(this.fs, name, toBytes(value), DEFAULT_MTIME));
      } else if (value instanceof FakeFileSpec) {
        this.children.set(name, new FakeFileHandle(this.fs, name, toBytes(value.content), value.lastModified));
      } else {
        const dir = new FakeDirHandle(this.fs, name);
        dir.populate(value);
        this.children.set(name, dir);
      }
    }
  }

  getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<FileSystemFileHandle> {
    if (this.fs.failures.getFileHandle && options?.create) return Promise.reject(this.fs.failures.getFileHandle);
    const existing = this.children.get(name);
    if (existing instanceof FakeFileHandle) return Promise.resolve(existing);
    if (existing) return Promise.reject(domError('TypeMismatchError'));
    if (!options?.create) return Promise.reject(domError('NotFoundError', `${name} not found`));
    if (this.fs.permission.readwrite !== 'granted') return Promise.reject(domError('NotAllowedError'));
    const created = new FakeFileHandle(this.fs, name, new Uint8Array(0), Date.now());
    this.children.set(name, created);
    return Promise.resolve(created);
  }

  getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions): Promise<FileSystemDirectoryHandle> {
    const existing = this.children.get(name);
    if (existing instanceof FakeDirHandle) return Promise.resolve(existing);
    if (existing) return Promise.reject(domError('TypeMismatchError'));
    if (!options?.create) return Promise.reject(domError('NotFoundError', `${name} not found`));
    const created = new FakeDirHandle(this.fs, name);
    this.children.set(name, created);
    return Promise.resolve(created);
  }

  removeEntry(name: string, options?: FileSystemRemoveOptions): Promise<void> {
    const existing = this.children.get(name);
    if (!existing) return Promise.reject(domError('NotFoundError'));
    if (existing instanceof FakeDirHandle && existing.children.size > 0 && !options?.recursive) {
      return Promise.reject(domError('InvalidModificationError'));
    }
    this.children.delete(name);
    return Promise.resolve();
  }

  resolve(possibleDescendant: FileSystemHandle): Promise<string[] | null> {
    return Promise.resolve(this.findPath(possibleDescendant));
  }

  private findPath(target: FileSystemHandle): string[] | null {
    if ((target as unknown) === this) return [];
    for (const [name, child] of this.children) {
      if ((target as unknown) === child) return [name];
      if (child instanceof FakeDirHandle) {
        const sub = child.findPath(target);
        if (sub) return [name, ...sub];
      }
    }
    return null;
  }

  async *entries(): AsyncGenerator<[string, FileSystemHandle]> {
    for (const [name, child] of [...this.children]) yield [name, child];
  }

  async *values(): AsyncGenerator<FileSystemHandle> {
    for (const child of [...this.children.values()]) yield child;
  }

  async *keys(): AsyncGenerator<string> {
    for (const name of [...this.children.keys()]) yield name;
  }

  [Symbol.asyncIterator](): AsyncGenerator<[string, FileSystemHandle]> {
    return this.entries();
  }
}

/** A node `File` carrying `webkitRelativePath`, as produced by `<input webkitdirectory>`. */
export function fileWithRelPath(relPath: string, content: FakeContent = '', lastModified = DEFAULT_MTIME): File {
  const name = relPath.split('/').pop() ?? relPath;
  const file = new File([toBytes(content).slice()], name, { lastModified });
  Object.defineProperty(file, 'webkitRelativePath', { value: relPath });
  return file;
}
