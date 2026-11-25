// The solo practice TableHost in a module Web Worker, so bot thinking never blocks the page (see local.js).
//
//   page -> worker: { op: 'init', opts: { code, settings, saved, script } }, { op: 'send', msg }, { op: 'close' }
//   worker -> page: { op: 'ready' } (once loaded), { op: 'msg', msg }, { op: 'save', entry: { at, host } },
//                   { op: 'result', summary }, { op: 'closed' }
import { createRunner } from './local.js';

let runner = null;

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.op === 'init' && !runner) {
    runner = createRunner({
      ...m.opts,
      emit: (msg) => self.postMessage({ op: 'msg', msg }),
      persist: (entry) => self.postMessage({ op: 'save', entry }),
      result: (summary) => self.postMessage({ op: 'result', summary }),
    });
    runner.connect();
  } else if (m.op === 'send' && runner) {
    runner.message(m.msg);
  } else if (m.op === 'close') {
    if (runner) runner.close();
    self.postMessage({ op: 'closed' });
  }
};

self.postMessage({ op: 'ready' });
