/// <reference lib="webworker" />
import { analyzeBeats, type AnalysisInput, type BeatAnalysis } from './beatDetect';

// 解析は数秒かかるので Worker に逃がし、UI が固まらないようにする。
self.onmessage = (event: MessageEvent<AnalysisInput>) => {
  try {
    const analysis: BeatAnalysis = analyzeBeats(event.data);
    (self as DedicatedWorkerGlobalScope).postMessage({ ok: true, analysis }, [
      analysis.onsetEnvelope.buffer,
    ]);
  } catch (cause) {
    (self as DedicatedWorkerGlobalScope).postMessage({
      ok: false,
      message: cause instanceof Error ? cause.message : '解析に失敗しました',
    });
  }
};
