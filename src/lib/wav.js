/*
 * Minimal RIFF/WAVE parser -- reads just enough (the "fmt " chunk's sample
 * rate/channels/bits-per-sample, and the "data" chunk's location/byte
 * length) to compute a WAV file's real audio duration, and to slice a
 * sub-range of one out into its own standalone WAV file, directly from
 * bytes, with no Premiere/UXP API involved -- same class of manual
 * byte-level handling auphonicClient.js already does for multipart uploads.
 *
 * Phase 4b uses both functions:
 *  - wavDurationSeconds: the consolidated-batch safeguard (queue.js) uses
 *    this to verify Auphonic's processed file wasn't time-shifted by a
 *    preset's own silence/gap-removal before trusting any per-clip
 *    offset/duration computed from the (pre-processing) export step -- see
 *    HANDOFF.md's "Key risk" note.
 *  - sliceWav: after that safeguard passes, queue.js slices each batch
 *    member's own segment out of the one shared downloaded file into its
 *    own small, standalone WAV -- deliberately NOT placed by importing the
 *    shared file once and trimming N different track-item in/out points
 *    against it. Placing a fresh track item's in/out is only proven, in
 *    this codebase, to work when the projectItem's own full default range
 *    IS the intended range (every existing placement is exactly this);
 *    trimming an interior sub-range afterward would mean the initial
 *    insert/overwrite action briefly places (and, for overwrite,
 *    destructively clobbers, or for insert, ripples) the FULL untrimmed
 *    shared file's length before any trim ever happens -- far more of the
 *    real timeline than the small per-unit collision check ever accounted
 *    for. Slicing locally first means every unit is placed through the
 *    exact same insertion.importAndPlace path Phases 1-4a already prove
 *    live, completely unchanged.
 *
 * Loaded as a plain <script> tag -- see the note at the top of
 * lib/secureStorage.js for why. No local dependencies. Published on
 * window.Auphonic.wav.
 */
(function () {
  function readAscii(view, offset, length) {
    let s = "";
    for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
    return s;
  }

  // Chunks are word-aligned -- a chunk's recorded size is its unpadded byte
  // length, but the next chunk starts one byte later if that size is odd.
  function parseWavLayout(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    if (readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE") {
      throw new Error("Not a RIFF/WAVE file.");
    }

    let offset = 12;
    let sampleRate = null;
    let numChannels = null;
    let bitsPerSample = null;
    let dataChunkStart = null;
    let dataChunkLength = null;
    let fmtChunkStart = null;
    let fmtChunkLength = null;

    while (offset + 8 <= view.byteLength) {
      const chunkId = readAscii(view, offset, 4);
      const chunkSize = view.getUint32(offset + 4, true);
      const chunkDataStart = offset + 8;

      if (chunkId === "fmt ") {
        fmtChunkStart = chunkDataStart;
        fmtChunkLength = chunkSize;
        numChannels = view.getUint16(chunkDataStart + 2, true);
        sampleRate = view.getUint32(chunkDataStart + 4, true);
        bitsPerSample = view.getUint16(chunkDataStart + 14, true);
      } else if (chunkId === "data") {
        dataChunkStart = chunkDataStart;
        dataChunkLength = chunkSize;
      }

      offset = chunkDataStart + chunkSize + (chunkSize % 2);
    }

    if (!sampleRate || !numChannels || !bitsPerSample || dataChunkStart === null) {
      throw new Error("Could not find fmt/data chunks in WAV file.");
    }

    return {
      view,
      sampleRate,
      numChannels,
      bitsPerSample,
      bytesPerFrame: numChannels * (bitsPerSample / 8),
      fmtChunkStart,
      fmtChunkLength,
      dataChunkStart,
      dataChunkLength,
    };
  }

  function wavDurationSeconds(arrayBuffer) {
    const layout = parseWavLayout(arrayBuffer);
    const bytesPerSecond = layout.sampleRate * layout.bytesPerFrame;
    return layout.dataChunkLength / bytesPerSecond;
  }

  /*
   * Returns a new, standalone ArrayBuffer containing a valid WAV file for
   * just [offsetSeconds, offsetSeconds + durationSeconds) of arrayBuffer's
   * audio -- same format (sample rate/channels/bit depth) as the source.
   * Clamped to the source's actual available data so a small, tolerated
   * timing drift (see queue.js's safeguard) on the very last unit in a
   * batch can never read past the end of the buffer.
   */
  function sliceWav(arrayBuffer, offsetSeconds, durationSeconds) {
    const layout = parseWavLayout(arrayBuffer);
    const bytesPerSecond = layout.sampleRate * layout.bytesPerFrame;

    let startByte = Math.round((offsetSeconds * bytesPerSecond) / layout.bytesPerFrame) * layout.bytesPerFrame;
    let lengthBytes = Math.round((durationSeconds * bytesPerSecond) / layout.bytesPerFrame) * layout.bytesPerFrame;
    startByte = Math.max(0, Math.min(startByte, layout.dataChunkLength));
    lengthBytes = Math.max(0, Math.min(lengthBytes, layout.dataChunkLength - startByte));

    const fmtBytes = new Uint8Array(arrayBuffer, layout.fmtChunkStart, layout.fmtChunkLength);
    const dataBytes = new Uint8Array(arrayBuffer, layout.dataChunkStart + startByte, lengthBytes);

    const fmtChunkTotal = 8 + layout.fmtChunkLength + (layout.fmtChunkLength % 2);
    const dataChunkTotal = 8 + lengthBytes + (lengthBytes % 2);
    const totalSize = 12 + fmtChunkTotal + dataChunkTotal;

    const out = new Uint8Array(totalSize);
    const outView = new DataView(out.buffer);
    let pos = 0;

    const writeAscii = (str) => {
      for (let i = 0; i < str.length; i++) out[pos + i] = str.charCodeAt(i);
      pos += str.length;
    };

    writeAscii("RIFF");
    outView.setUint32(pos, totalSize - 8, true);
    pos += 4;
    writeAscii("WAVE");

    writeAscii("fmt ");
    outView.setUint32(pos, layout.fmtChunkLength, true);
    pos += 4;
    out.set(fmtBytes, pos);
    pos += layout.fmtChunkLength + (layout.fmtChunkLength % 2);

    writeAscii("data");
    outView.setUint32(pos, lengthBytes, true);
    pos += 4;
    out.set(dataBytes, pos);

    return out.buffer;
  }

  window.Auphonic = window.Auphonic || {};
  window.Auphonic.wav = { wavDurationSeconds, sliceWav };
})();
