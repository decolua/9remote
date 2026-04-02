/**
 * Live2D Lipsync Engine
 * Real-time audio analysis and mouth synchronization
 */

export class LipsyncEngine {
  constructor() {
    this.audioContext = null;
    this.analyser = null;
    this.dataArray = null;
    this.isActive = false;
    this.model = null;
    this.animationFrame = null;
    
    // Lipsync parameters
    this.smoothingFactor = 0.3;
    this.sensitivity = 2.0;
    this.threshold = 10;
    this.lastMouthValue = 0;
    
    // Audio buffer for processing
    this.bufferLength = 256;
    this.frequencyBins = null;
    
    this.initializeAudioContext();
  }

  /**
   * Initialize Web Audio API context
   */
  async initializeAudioContext() {
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.audioContext.createAnalyser();
      
      // Configure analyser for speech analysis
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.3;
      this.analyser.minDecibels = -90;
      this.analyser.maxDecibels = -10;
      
      this.bufferLength = this.analyser.frequencyBinCount;
      this.dataArray = new Uint8Array(this.bufferLength);
      this.frequencyBins = new Float32Array(this.bufferLength);
      
      console.log("Lipsync Engine initialized successfully");
    } catch (error) {
      console.error("Failed to initialize audio context:", error);
    }
  }

  /**
   * Start lipsync with Live2D model
   * @param {Object} model - Live2D model instance
   */
  startLipsync(model) {
    this.model = model;
    this.isActive = true;
    
    if (this.audioContext && this.audioContext.state === "suspended") {
      this.audioContext.resume();
    }
    
    this.updateLoop();
    console.log("Lipsync started");
  }

  /**
   * Stop lipsync and reset mouth position
   */
  stopLipsync() {
    this.isActive = false;
    
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    
    // Reset mouth to closed position
    if (this.model) {
      this.setMouthValue(0);
    }
    
    console.log("Lipsync stopped");
  }

  /**
   * Connect audio source for analysis
   * @param {HTMLAudioElement} audioElement - Audio element to analyze
   */
  connectAudioSource(audioElement) {
    try {
      if (!this.audioContext || !this.analyser) {
        throw new Error("Audio context not initialized");
      }

      // Create audio source from element
      const source = this.audioContext.createMediaElementSource(audioElement);
      
      // Connect: source -> analyser -> destination
      source.connect(this.analyser);
      this.analyser.connect(this.audioContext.destination);
      
      console.log("Audio source connected for lipsync");
      return source;
    } catch (error) {
      console.error("Failed to connect audio source:", error);
      return null;
    }
  }

  /**
   * Connect audio from base64 data
   * @param {string} audioBase64 - Base64 audio data
   * @returns {Promise<HTMLAudioElement>}
   */
  async connectBase64Audio(audioBase64) {
    try {
      // Create audio element from base64
      const audio = new Audio(audioBase64);
      audio.crossOrigin = "anonymous";
      
      // Wait for audio to be ready
      await new Promise((resolve, reject) => {
        audio.addEventListener("canplaythrough", resolve);
        audio.addEventListener("error", reject);
        audio.load();
      });

      // Connect to analyser
      this.connectAudioSource(audio);
      
      return audio;
    } catch (error) {
      console.error("Failed to connect base64 audio:", error);
      return null;
    }
  }

  /**
   * Main update loop for lipsync
   */
  updateLoop() {
    if (!this.isActive || !this.analyser || !this.model) {
      return;
    }

    // Get frequency data
    this.analyser.getByteFrequencyData(this.dataArray);
    
    // Analyze speech patterns
    const mouthValue = this.analyzeSpeechPatterns();
    
    // Apply mouth movement to model
    this.setMouthValue(mouthValue);
    
    // Continue loop
    this.animationFrame = requestAnimationFrame(() => this.updateLoop());
  }

  /**
   * Analyze audio data for speech patterns
   * @returns {number} Mouth opening value (0-1)
   */
  analyzeSpeechPatterns() {
    if (!this.dataArray || this.dataArray.length === 0) {
      return 0;
    }

    // Focus on speech frequency range (85Hz - 2000Hz)
    const speechStart = Math.floor(85 * this.bufferLength / (this.audioContext.sampleRate / 2));
    const speechEnd = Math.floor(2000 * this.bufferLength / (this.audioContext.sampleRate / 2));
    
    let totalEnergy = 0;
    let peakAmplitude = 0;

    // Calculate energy in speech range
    for (let i = speechStart; i < Math.min(speechEnd, this.dataArray.length); i++) {
      const amplitude = this.dataArray[i];
      totalEnergy += amplitude * amplitude;
      
      if (amplitude > peakAmplitude) {
        peakAmplitude = amplitude;
      }
    }

    // RMS (Root Mean Square) for smooth amplitude
    const rms = Math.sqrt(totalEnergy / (speechEnd - speechStart));
    
    // Apply sensitivity and threshold
    let mouthValue = (rms - this.threshold) / 255 * this.sensitivity;
    mouthValue = Math.max(0, Math.min(1, mouthValue));
    
    // Smooth the mouth movement
    mouthValue = this.lastMouthValue * (1 - this.smoothingFactor) + mouthValue * this.smoothingFactor;
    this.lastMouthValue = mouthValue;
    
    return mouthValue;
  }

  /**
   * Apply mouth value to Live2D model
   * @param {number} value - Mouth opening (0-1)
   */
  setMouthValue(value) {
    if (!this.model) return;

    try {
      // Apply to different Live2D implementations
      if (window.L2Dwidget && window.L2Dwidget.model) {
        // For L2Dwidget
        if (window.L2Dwidget.model.setParameterValueById) {
          window.L2Dwidget.model.setParameterValueById("ParamMouthOpenY", value);
          window.L2Dwidget.model.setParameterValueById("ParamMouthForm", value * 0.3);
        }
      } else if (this.model.setParameterValueById) {
        // For direct Live2D model
        this.model.setParameterValueById("ParamMouthOpenY", value);
        this.model.setParameterValueById("ParamMouthForm", value * 0.3);
        this.model.setParameterValueById("mouthOpenY", value);
        this.model.setParameterValueById("mouthForm", value * 0.3);
      }

      // Update model if needed
      if (this.model.update) {
        this.model.update();
      }
    } catch (error) {
      console.warn("Could not set mouth parameter:", error);
    }
  }

  /**
   * Configure lipsync sensitivity
   * @param {number} sensitivity - Sensitivity multiplier (0.5 - 5.0)
   * @param {number} smoothing - Smoothing factor (0.1 - 0.9)
   * @param {number} threshold - Audio threshold (0 - 50)
   */
  configure(sensitivity = 2.0, smoothing = 0.3, threshold = 10) {
    this.sensitivity = Math.max(0.5, Math.min(5.0, sensitivity));
    this.smoothingFactor = Math.max(0.1, Math.min(0.9, smoothing));
    this.threshold = Math.max(0, Math.min(50, threshold));
    
    console.log(`Lipsync configured: sensitivity=${this.sensitivity}, smoothing=${this.smoothingFactor}, threshold=${this.threshold}`);
  }

  /**
   * Get current lipsync status
   * @returns {Object} Status information
   */
  getStatus() {
    return {
      isActive: this.isActive,
      hasModel: !!this.model,
      hasAudioContext: !!this.audioContext,
      lastMouthValue: this.lastMouthValue,
      sensitivity: this.sensitivity,
      smoothingFactor: this.smoothingFactor,
      threshold: this.threshold
    };
  }

  /**
   * Cleanup resources
   */
  destroy() {
    this.stopLipsync();
    
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    
    this.analyser = null;
    this.dataArray = null;
    this.model = null;
    
    console.log("Lipsync Engine destroyed");
  }
}

// Create global lipsync instance
export const lipsyncEngine = new LipsyncEngine();

/**
 * Easy-to-use lipsync functions
 */

/**
 * Start lipsync with audio element
 * @param {Object} model - Live2D model
 * @param {HTMLAudioElement} audioElement - Audio element
 */
export function startLipsyncWithAudio(model, audioElement) {
  lipsyncEngine.startLipsync(model);
  lipsyncEngine.connectAudioSource(audioElement);
  
  // Stop lipsync when audio ends
  audioElement.addEventListener("ended", () => {
    lipsyncEngine.stopLipsync();
  });
}

/**
 * Start lipsync with base64 audio
 * @param {Object} model - Live2D model
 * @param {string} audioBase64 - Base64 audio data
 * @returns {Promise<HTMLAudioElement>}
 */
export async function startLipsyncWithBase64(model, audioBase64) {
  const audio = await lipsyncEngine.connectBase64Audio(audioBase64);
  if (audio) {
    lipsyncEngine.startLipsync(model);
    
    // Auto-stop when audio ends
    audio.addEventListener("ended", () => {
      lipsyncEngine.stopLipsync();
    });
    
    return audio;
  }
  return null;
}

/**
 * Stop all lipsync activity
 */
export function stopLipsync() {
  lipsyncEngine.stopLipsync();
}

/**
 * Configure lipsync parameters
 * @param {Object} config - Configuration object
 */
export function configureLipsync(config = {}) {
  const {
    sensitivity = 2.0,
    smoothing = 0.3,
    threshold = 10
  } = config;
  
  lipsyncEngine.configure(sensitivity, smoothing, threshold);
}

/**
 * Get lipsync status
 * @returns {Object} Current status
 */
export function getLipsyncStatus() {
  return lipsyncEngine.getStatus();
}
