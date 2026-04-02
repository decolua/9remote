// Live2D Lip Sync — Web Audio API
// Ported from .source/live_ai/src/lib/lipSync.js

function base64AudioToBlob(dataUrl) {
  const parts = dataUrl.split(",");
  const mime = parts[0].match(/:(.*?);/)[1];
  const base64 = parts[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

export function addLipSyncToModel(model) {
  if (!model || model.startLipSyncFromBase64Audio) return;

  model.startLipSyncFromBase64Audio = async function (dataUrl) {
    const m = this;

    if (!m.audioContext) {
      m.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    try {
      if (m.audioContext.state !== "running") {
        await m.audioContext.resume();
      }
    } catch {}

    try {
      const blob = base64AudioToBlob(dataUrl);
      const arrayBuffer = await blob.arrayBuffer();
      const audioBuffer = await m.audioContext.decodeAudioData(arrayBuffer);

      const source = m.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.playbackRate.value = 1.15;

      const analyser = m.audioContext.createAnalyser();
      analyser.fftSize = 512;
      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      source.connect(analyser);
      analyser.connect(m.audioContext.destination);

      if (m._lipSyncAnimation) {
        cancelAnimationFrame(m._lipSyncAnimation);
      }

      function updateLipSync() {
        analyser.getByteTimeDomainData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const val = (dataArray[i] - 128) / 128;
          sum += val * val;
        }
        const volume = Math.min(Math.sqrt(sum / dataArray.length) * 2, 1);

        try {
          m.internalModel?.coreModel?.setParameterValueById("ParamMouthOpenY", volume);
        } catch {}

        if (!source.ended && m.audioContext.state === "running") {
          m._lipSyncAnimation = requestAnimationFrame(updateLipSync);
        } else {
          try {
            m.internalModel?.coreModel?.setParameterValueById("ParamMouthOpenY", 0);
          } catch {}
          m._lipSyncAnimation = null;
        }
      }

      source.onended = () => {
        try {
          m.internalModel?.coreModel?.setParameterValueById("ParamMouthOpenY", 0);
        } catch {}
        if (m._lipSyncAnimation) {
          cancelAnimationFrame(m._lipSyncAnimation);
          m._lipSyncAnimation = null;
        }
      };

      source.start();
      updateLipSync();

      return source;
    } catch (err) {
      console.error("Lip sync error:", err);
      throw err;
    }
  };

  model.stopLipSync = function () {
    if (this._lipSyncAnimation) {
      cancelAnimationFrame(this._lipSyncAnimation);
      this._lipSyncAnimation = null;
    }
    try {
      this.internalModel?.coreModel?.setParameterValueById("ParamMouthOpenY", 0);
    } catch {}
  };
}
