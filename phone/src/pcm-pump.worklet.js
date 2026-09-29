// AudioWorklet：把 128 帧回调累积成 960 样本（20ms @48kHz）的块后转发主线程。
// 保持为纯 JS 文件，不经构建转换，通过 new URL(...) 以静态资源加载。
class PcmPumpProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._chunk = new Float32Array(960);
    this._filled = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true; // 无输入也保持节点存活
    let i = 0;
    while (i < ch.length) {
      const n = Math.min(ch.length - i, this._chunk.length - this._filled);
      this._chunk.set(ch.subarray(i, i + n), this._filled);
      this._filled += n;
      i += n;
      if (this._filled === this._chunk.length) {
        const out = this._chunk.slice(0);
        this.port.postMessage(out, [out.buffer]);
        this._filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-pump", PcmPumpProcessor);
