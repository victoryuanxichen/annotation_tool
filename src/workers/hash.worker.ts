/// <reference lib="webworker" />
import { HashScheduler, blobSource, computeFingerprint } from '../storage/hashCore';
import { serializeError, type HashWorkerRequest, type HashWorkerResponse } from '../storage/hashProtocol';
import { createWasmSha256 } from '../storage/wasmHasher';

const scheduler = new HashScheduler({ createHasher: createWasmSha256 });
const controllers = new Map<number, AbortController>();

function post(message: HashWorkerResponse): void {
  (self as unknown as Worker).postMessage(message);
}

async function run(id: number, work: (signal: AbortSignal) => Promise<string>): Promise<void> {
  const controller = new AbortController();
  controllers.set(id, controller);
  try {
    post({ type: 'result', id, value: await work(controller.signal) });
  } catch (e) {
    post({ type: 'error', id, error: serializeError(e) });
  } finally {
    controllers.delete(id);
  }
}

self.onmessage = (ev: MessageEvent<HashWorkerRequest>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'cancel':
      controllers.get(msg.id)?.abort();
      return;
    case 'fingerprint':
      void run(msg.id, () => computeFingerprint(blobSource(msg.file), createWasmSha256));
      return;
    case 'sha256':
      void run(msg.id, (signal) =>
        scheduler.request(msg.key, blobSource(msg.file), {
          priority: msg.priority,
          signal,
          onProgress: (done, total) => post({ type: 'progress', id: msg.id, done, total }),
        }),
      );
      return;
  }
};
