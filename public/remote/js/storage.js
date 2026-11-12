// 录像落盘：优先写进用户选定的文件夹（File System Access，边录边写、不占内存）；
// 没选文件夹时写进浏览器私有存储（OPFS）；拿不到 OPFS（无线模式的 http 页面不是安全上下文）时写进 IndexedDB——
// 两种都是刷新页面还在，需要时在视频列表里导出。

const DB = 'sunight-remote';
const STORE = 'handles';
/** http 页面的录像：分块（chunks，键 `名称#序号`）+ 每个视频一条说明（videos，键为名称）。 */
const CHUNKS = 'chunks';
const VIDEOS = 'videos';
const CHUNK_BYTES = 8 * 1024 * 1024;

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of [STORE, CHUNKS, VIDEOS]) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
}

async function idbSet(key, value, store = STORE) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGetFrom(store, key) {
  const db = await idb();
  return new Promise((resolve) => {
    const req = db.transaction(store).objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
}

async function idbAll(store) {
  const db = await idb();
  return new Promise((resolve) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => resolve([]);
  });
}

async function idbDeleteVideo(name, count) {
  const db = await idb();
  return new Promise((resolve) => {
    const tx = db.transaction([CHUNKS, VIDEOS], 'readwrite');
    for (let i = 0; i < count; i++) tx.objectStore(CHUNKS).delete(`${name}#${i}`);
    tx.objectStore(VIDEOS).delete(name);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/** IndexedDB 里一个视频 → 视频列表要的那份描述（取文件时把分块拼成一个 Blob，Blob 本身在磁盘上，不占内存）。 */
function idbItem(meta) {
  return {
    name: meta.name, size: meta.size, durationMs: meta.durationMs ?? 0, where: '浏览器内',
    file: async () => {
      const parts = [];
      for (let i = 0; i < meta.count; i++) { const b = await idbGetFrom(CHUNKS, `${meta.name}#${i}`); if (b) parts.push(b); }
      return new Blob(parts, { type: 'video/mp4' });
    },
    remove: () => idbDeleteVideo(meta.name, meta.count),
  };
}

export const Storage = {
  folderSupported() { return typeof window !== 'undefined' && 'showDirectoryPicker' in window; },

  async savedFolder() {
    if (!Storage.folderSupported()) return null;
    try { return await idbGet('folder'); } catch { return null; }
  },

  async chooseFolder() {
    const handle = await window.showDirectoryPicker({ id: 'sunight-recordings', mode: 'readwrite', startIn: 'videos' });
    await idbSet('folder', handle);
    return handle;
  },

  /** 需要在用户点击里调用：浏览器重启后文件夹权限要再确认一次。 */
  async ensurePermission(handle) {
    if (!handle) return false;
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    return (await handle.requestPermission(opts)) === 'granted';
  },

  /** 返回 Recorder 需要的 createTarget。 */
  targetFactory(folder) {
    if (folder) {
      return async (name) => {
        const fileHandle = await folder.getFileHandle(name, { create: true });
        const writable = await fileHandle.createWritable();
        let size = 0;
        return {
          name,
          async write(bytes) { size += bytes.length; await writable.write(bytes); },
          async finish() {
            await writable.close();
            return { name, size, file: () => fileHandle.getFile(), remove: () => folder.removeEntry(name), where: folder.name };
          },
        };
      };
    }
    // 没选文件夹：写进浏览器给本站的私有存储（OPFS）。静默写入、不弹下载、刷新页面还在；
    // 需要时在视频列表里「保存到电脑」导出。拿不到 OPFS（http 无线页面）时只放在内存里。
    return async (name) => {
      const dir = await Storage.privateDir();
      if (dir) {
        const fileHandle = await dir.getFileHandle(name, { create: true });
        const writable = await fileHandle.createWritable();
        let size = 0;
        return {
          name,
          async write(bytes) { size += bytes.length; await writable.write(bytes); },
          async finish() {
            await writable.close();
            return { name, size, file: () => fileHandle.getFile(), remove: () => dir.removeEntry(name), where: '浏览器内' };
          },
        };
      }
      // IndexedDB：攒满 8 MB 落一块，内存里最多只压着一块；录完写一条说明，刷新页面后据此列回视频列表。
      let parts = [];
      let pending = 0;
      let size = 0;
      let count = 0;
      const flush = async () => {
        if (!pending) return;
        const blob = new Blob(parts, { type: 'video/mp4' });
        parts = []; pending = 0;
        await idbSet(`${name}#${count}`, blob, CHUNKS);
        count++;
      };
      return {
        name,
        async write(bytes) {
          size += bytes.length; pending += bytes.length; parts.push(bytes);
          if (pending >= CHUNK_BYTES) await flush();
        },
        async finish() {
          await flush();
          const meta = { name, size, count, savedAt: Date.now() };
          await idbSet(name, meta, VIDEOS);
          return idbItem(meta);
        },
      };
    };
  },

  /** 录完知道了时长再补记进 IndexedDB 的说明里（只对存在 IndexedDB 的录像有效，其它情况什么都不做）。 */
  async rememberDuration(name, durationMs) {
    try {
      const meta = await idbGetFrom(VIDEOS, name);
      if (meta && durationMs) await idbSet(name, { ...meta, durationMs }, VIDEOS);
    } catch { /* 不影响录像本身 */ }
  },

  /** http 页面存在 IndexedDB 里的录像（最新在前）：刷新后放回视频列表。 */
  async idbVideos() {
    try {
      const metas = await idbAll(VIDEOS);
      return metas.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0)).map(idbItem);
    } catch { return []; }
  },

  /** 浏览器私有存储里放录像的目录；不支持时为 null。 */
  async privateDir() {
    try {
      if (!navigator.storage?.getDirectory) return null;
      const root = await navigator.storage.getDirectory();
      return await root.getDirectoryHandle('recordings', { create: true });
    } catch { return null; }
  },

  /** 把一个视频交给浏览器下载（用户点了「保存到电脑」才会走到这里）。 */
  download(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
};

export function timestampName(prefix = 'Remote') {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${prefix}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
