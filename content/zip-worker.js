'use strict';
self.onmessage = async function (e) {
  const { files, zipFilename, jszipUrl } = e.data;
  try {
    self.importScripts(jszipUrl);
    const zip = new self.JSZip();

    async function pMap(items, fn, concurrency) {
      const results = [];
      const pool = new Set();
      for (const item of items) {
        const p = fn(item);
        results.push(p);
        if (concurrency > 1 && items.length > 1) {
          const e = Promise.resolve(p).finally(() => pool.delete(e));
          pool.add(e);
          if (pool.size >= concurrency) await Promise.race(pool);
        }
      }
      if (pool.size) await Promise.allSettled([...pool]);
      return Promise.allSettled(results);
    }

    const entries = await pMap(files, async (f) => {
      const resp = await fetch(f.url, { headers: { 'Referer': 'https://www.instagram.com/' } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${f.filename}`);
      const blob = await resp.blob();
      return { filename: f.filename.split('/').pop(), blob };
    }, 8);

    let done = 0;
    const total = files.length;
    for (const entry of entries) {
      if (entry.status === 'fulfilled') {
        zip.file(entry.value.filename, entry.value.blob);
      }
      done++;
      self.postMessage({ type: 'progress', done, total });
    }

    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    self.postMessage({ type: 'done', blob, zipFilename });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
