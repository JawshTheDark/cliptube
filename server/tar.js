/**
 * Minimal streaming tar (ustar) writer and reader, enough for data exports and channel
 * export/import without extra dependencies.
 */
import fs from 'node:fs';

function octal(n, width) {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name, size, mtime, type = '0') {
  const buf = Buffer.alloc(512, 0);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 154);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`Name too long for tar: ${name}`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  buf.write(base, 0, 100, 'utf8');
  buf.write(octal(type === '5' ? 0o755 : 0o644, 8), 100, 8, 'ascii');
  buf.write(octal(0, 8), 108, 8, 'ascii');
  buf.write(octal(0, 8), 116, 8, 'ascii');
  buf.write(octal(size, 12), 124, 12, 'ascii');
  buf.write(octal(Math.floor(mtime / 1000), 12), 136, 12, 'ascii');
  buf.write('        ', 148, 8, 'ascii'); // checksum placeholder
  buf.write(type, 156, 1, 'ascii');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  buf.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(octal(sum, 7) + ' ', 148, 8, 'ascii');
  return buf;
}

/**
 * Writes a tar file. entries: [{ name, data (Buffer|string) } | { name, file (path on disk) }].
 * Files are streamed, so large videos don't need to fit in memory.
 */
export async function writeTar(outPath, entries) {
  const fh = await fs.promises.open(outPath, 'w');
  try {
    for (const e of entries) {
      if (e.file) {
        const st = await fs.promises.stat(e.file);
        await fh.write(header(e.name, st.size, st.mtimeMs));
        const src = await fs.promises.open(e.file, 'r');
        try {
          const chunk = Buffer.alloc(1024 * 1024);
          let pos = 0;
          for (;;) {
            const { bytesRead } = await src.read(chunk, 0, chunk.length, pos);
            if (!bytesRead) break;
            await fh.write(chunk.subarray(0, bytesRead));
            pos += bytesRead;
          }
        } finally {
          await src.close();
        }
        const pad = (512 - (st.size % 512)) % 512;
        if (pad) await fh.write(Buffer.alloc(pad));
      } else {
        const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8');
        await fh.write(header(e.name, data.length, Date.now()));
        await fh.write(data);
        const pad = (512 - (data.length % 512)) % 512;
        if (pad) await fh.write(Buffer.alloc(pad));
      }
    }
    await fh.write(Buffer.alloc(1024));
  } finally {
    await fh.close();
  }
}

/**
 * Reads a tar file's entries without loading file contents: returns [{ name, size, offset }].
 * Use readTarEntry or copyTarEntry to get at the data.
 */
export async function listTar(tarPath) {
  const fh = await fs.promises.open(tarPath, 'r');
  const out = [];
  try {
    const hdr = Buffer.alloc(512);
    let pos = 0;
    for (;;) {
      const { bytesRead } = await fh.read(hdr, 0, 512, pos);
      if (bytesRead < 512 || hdr.every((b) => b === 0)) break;
      const cstr = (start, len) => hdr.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '');
      const name = (cstr(345, 155) ? `${cstr(345, 155)}/` : '') + cstr(0, 100);
      const size = parseInt(cstr(124, 12).trim() || '0', 8);
      const type = cstr(156, 1) || '0';
      if (type === '0' || type === '') out.push({ name, size, offset: pos + 512 });
      pos += 512 + Math.ceil(size / 512) * 512;
    }
  } finally {
    await fh.close();
  }
  return out;
}

export async function readTarEntry(tarPath, entry) {
  const fh = await fs.promises.open(tarPath, 'r');
  try {
    const buf = Buffer.alloc(entry.size);
    await fh.read(buf, 0, entry.size, entry.offset);
    return buf;
  } finally {
    await fh.close();
  }
}

export async function copyTarEntry(tarPath, entry, dest) {
  const src = await fs.promises.open(tarPath, 'r');
  const out = await fs.promises.open(dest, 'w');
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    let done = 0;
    while (done < entry.size) {
      const n = Math.min(chunk.length, entry.size - done);
      const { bytesRead } = await src.read(chunk, 0, n, entry.offset + done);
      if (!bytesRead) throw new Error('Unexpected end of archive');
      await out.write(chunk.subarray(0, bytesRead));
      done += bytesRead;
    }
  } finally {
    await src.close();
    await out.close();
  }
}
