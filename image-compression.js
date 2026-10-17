/* Browser-only compression; no image data leaves the device. */
(() => {
  const encoder = new TextEncoder();
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const bytes = new Uint8Array(data.length + 12), view = new DataView(bytes.buffer);
    view.setUint32(0, data.length);
    bytes.set(encoder.encode(type), 4);
    bytes.set(data, 8);
    view.setUint32(bytes.length - 4, crc32(bytes.subarray(4, bytes.length - 4)));
    return bytes;
  }
  async function optimizePng(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length < 20 || bytes[0] !== 137 || bytes[1] !== 80) return blob;
    const view = new DataView(bytes.buffer), parts = [bytes.slice(0, 8)], imageData = [];
    let firstIdat = -1, ended = false;
    // Keep color management, transparency and other rendering-related chunks.
    const metadata = new Set(['tEXt', 'zTXt', 'iTXt', 'tIME', 'eXIf']);
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset), end = offset + length + 12;
      if (end > bytes.length) return blob;
      const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      // Animated PNG must not be rewritten as a static PNG.
      if (type === 'acTL') return blob;
      if (type === 'IDAT') {
        if (firstIdat < 0) { firstIdat = parts.length; parts.push(null); }
        imageData.push(bytes.slice(offset + 8, offset + 8 + length));
      } else if (!metadata.has(type)) parts.push(bytes.slice(offset, end));
      offset = end;
      if (type === 'IEND') { ended = true; break; }
    }
    if (!ended || firstIdat < 0) return blob;
    let compressed = new Uint8Array(await new Blob(imageData).arrayBuffer());
    if (typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined') {
      try {
        const stream = new Blob(imageData).stream().pipeThrough(new DecompressionStream('deflate')).pipeThrough(new CompressionStream('deflate'));
        const candidate = new Uint8Array(await new Response(stream).arrayBuffer());
        if (candidate.length < compressed.length) compressed = candidate;
      } catch { /* Keep the original pixel stream if this browser cannot recompress it. */ }
    }
    parts[firstIdat] = chunk('IDAT', compressed);
    const result = new Blob(parts, {type: 'image/png'});
    return result.size < blob.size ? result : blob;
  }
  async function compress(canvas, original, format, quality, unchangedSize) {
    const encoded = await new Promise(resolve => canvas.toBlob(resolve, format, format === 'image/png' ? undefined : quality / 100));
    if (!encoded) throw new Error('圖片壓縮失敗');
    if (encoded.type !== format) throw new Error('此瀏覽器不支援選擇的輸出格式');
    let best = format === 'image/png' ? await optimizePng(encoded) : encoded;
    if (unchangedSize && original.type === format) {
      const source = format === 'image/png' ? await optimizePng(original) : original;
      if (source.size <= best.size) best = source;
    }
    return best;
  }
  async function compressToTarget(canvas, original, format, quality, unchangedSize, targetBytes) {
    const bestInitial = await compress(canvas, original, format, quality, unchangedSize);
    const target = Number.isFinite(targetBytes) && targetBytes > 0 ? Math.floor(targetBytes) : null;
    if (!target || bestInitial.size <= target || format === 'image/png') {
      return {blob: bestInitial, targetBytes: target, met: !target || bestInitial.size <= target};
    }
    // Search encoding quality only; never change the canvas dimensions or selected format.
    const encode = value => new Promise((resolve, reject) => canvas.toBlob(blob => {
      if (!blob || blob.type !== format) reject(new Error('圖片壓縮失敗或格式不受支援'));
      else resolve(blob);
    }, format, value / 100));
    let best = bestInitial, low = 1, high = Math.min(100, Math.max(1, Math.floor(quality))), fitting = null;
    const smallest = await encode(low);
    if (smallest.size < best.size) best = smallest;
    if (smallest.size > target) return {blob: best, targetBytes: target, met: false};
    fitting = smallest;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2), candidate = await encode(middle);
      if (candidate.size <= target) { fitting = candidate; low = middle + 1; }
      else high = middle - 1;
    }
    return {blob: fitting, targetBytes: target, met: true};
  }
  window.J5XImageCompression = {compress, compressToTarget};
})();
