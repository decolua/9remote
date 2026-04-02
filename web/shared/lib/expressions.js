const EMOTIONS = { IDLE: "idle", HAPPY: "happy", SAD: "sad", SURPRISED: "surprised", THINKING: "thinking" };
const GESTURES = { NOD: "nod", SHAKE: "shake", WAVE: "wave" };

/**
 * Map emotions to Live2D expression parameters
 */
export const EXPRESSION_MAPPINGS = {
  [EMOTIONS.IDLE]: {
    eyeOpenLeft: 1.0,
    eyeOpenRight: 1.0,
    eyeBrowLeftY: 0.0,
    eyeBrowRightY: 0.0,
    mouthForm: 0.0,
    mouthOpenY: 0.0
  },
  [EMOTIONS.HAPPY]: {
    eyeOpenLeft: 0.6,
    eyeOpenRight: 0.6,
    eyeBrowLeftY: -0.3,
    eyeBrowRightY: -0.3,
    mouthForm: 1.0,
    mouthOpenY: 0.3
  },
  [EMOTIONS.SAD]: {
    eyeOpenLeft: 0.8,
    eyeOpenRight: 0.8,
    eyeBrowLeftY: 0.5,
    eyeBrowRightY: 0.5,
    mouthForm: -0.8,
    mouthOpenY: 0.0
  },
  [EMOTIONS.SURPRISED]: {
    eyeOpenLeft: 1.5,
    eyeOpenRight: 1.5,
    eyeBrowLeftY: -0.8,
    eyeBrowRightY: -0.8,
    mouthForm: 0.0,
    mouthOpenY: 0.8
  },
  [EMOTIONS.THINKING]: {
    eyeOpenLeft: 0.5,
    eyeOpenRight: 1.0,
    eyeBrowLeftY: 0.3,
    eyeBrowRightY: -0.2,
    mouthForm: -0.3,
    mouthOpenY: 0.0
  }
};

/**
 * Map gestures to animation sequences
 */
export const GESTURE_MAPPINGS = {
  [GESTURES.NOD]: {
    duration: 1000,
    keyframes: [
      { time: 0, angleY: 0 },
      { time: 0.3, angleY: 15 },
      { time: 0.6, angleY: -5 },
      { time: 1.0, angleY: 0 }
    ]
  },
  [GESTURES.SHAKE]: {
    duration: 1200,
    keyframes: [
      { time: 0, angleY: 0 },
      { time: 0.25, angleY: -20 },
      { time: 0.5, angleY: 20 },
      { time: 0.75, angleY: -15 },
      { time: 1.0, angleY: 0 }
    ]
  },
  [GESTURES.WAVE]: {
    duration: 2000,
    keyframes: [
      { time: 0, armRightY: 0 },
      { time: 0.2, armRightY: -30 },
      { time: 0.4, armRightY: -10 },
      { time: 0.6, armRightY: -30 },
      { time: 0.8, armRightY: -10 },
      { time: 1.0, armRightY: 0 }
    ]
  }
};

/**
 * Apply expression to Live2D model
 * @param {Object} model - Live2D model instance
 * @param {string} emotion - Emotion type
 * @param {number} intensity - Expression intensity (0-1)
 */
export function applyExpression(model, emotion, intensity = 1.0) {
  const expression = EXPRESSION_MAPPINGS[emotion];
  if (!expression || !model) return;

  try {
    // Apply each parameter with intensity multiplier
    Object.entries(expression).forEach(([param, value]) => {
      const finalValue = value * intensity;
      
      // Mock implementation for now - will be replaced with actual Live2D API
      if (model.setParameterValueById) {
        model.setParameterValueById(param, finalValue);
      }
    });

    // Update model
    if (model.update) {
      model.update();
    }
  } catch (error) {
    console.error("Error applying expression:", error);
  }
}

/**
 * Play gesture animation
 * @param {Object} model - Live2D model instance  
 * @param {string} gesture - Gesture type
 * @param {Function} onComplete - Callback when animation completes
 */
export function playGesture(model, gesture, onComplete) {
  const gestureData = GESTURE_MAPPINGS[gesture];
  if (!gestureData || !model) {
    if (onComplete) onComplete();
    return;
  }

  const { duration, keyframes } = gestureData;
  const startTime = Date.now();

  function animate() {
    const elapsed = Date.now() - startTime;
    const progress = Math.min(elapsed / duration, 1.0);

    // Find current keyframe
    let currentFrame = keyframes[0];
    let nextFrame = keyframes[1];

    for (let i = 0; i < keyframes.length - 1; i++) {
      if (progress >= keyframes[i].time && progress <= keyframes[i + 1].time) {
        currentFrame = keyframes[i];
        nextFrame = keyframes[i + 1];
        break;
      }
    }

    if (nextFrame) {
      // Interpolate between keyframes
      const frameProgress = (progress - currentFrame.time) / (nextFrame.time - currentFrame.time);
      
      Object.keys(currentFrame).forEach(param => {
        if (param === "time") return;
        
        const currentValue = currentFrame[param];
        const nextValue = nextFrame[param];
        const interpolatedValue = currentValue + (nextValue - currentValue) * frameProgress;
        
        // Mock implementation - will be replaced with actual Live2D API
        if (model.setParameterValueById) {
          model.setParameterValueById(param, interpolatedValue);
        }
      });
    }

    // Update model
    if (model.update) {
      model.update();
    }

    if (progress < 1.0) {
      requestAnimationFrame(animate);
    } else {
      if (onComplete) onComplete();
    }
  }

  animate();
}

/**
 * Create smooth transition between expressions
 * @param {Object} model - Live2D model instance
 * @param {string} fromEmotion - Starting emotion
 * @param {string} toEmotion - Target emotion
 * @param {number} duration - Transition duration in ms
 */
export function transitionExpression(model, fromEmotion, toEmotion, duration = 500) {
  const fromExpression = EXPRESSION_MAPPINGS[fromEmotion];
  const toExpression = EXPRESSION_MAPPINGS[toEmotion];
  
  if (!fromExpression || !toExpression || !model) return;

  const startTime = Date.now();

  function animate() {
    const elapsed = Date.now() - startTime;
    const progress = Math.min(elapsed / duration, 1.0);
    
    // Easing function (ease-out)
    const easedProgress = 1 - Math.pow(1 - progress, 3);

    // Interpolate between expressions
    Object.keys(toExpression).forEach(param => {
      const fromValue = fromExpression[param] || 0;
      const toValue = toExpression[param];
      const interpolatedValue = fromValue + (toValue - fromValue) * easedProgress;
      
      // Mock implementation - will be replaced with actual Live2D API
      if (model.setParameterValueById) {
        model.setParameterValueById(param, interpolatedValue);
      }
    });

    // Update model
    if (model.update) {
      model.update();
    }

    if (progress < 1.0) {
      requestAnimationFrame(animate);
    }
  }

  animate();
}

/**
 * Generate random idle animation
 * @param {Object} model - Live2D model instance
 */
export function playIdleAnimation(model) {
  if (!model) return;

  const blinkDuration = 150;
  const blinkInterval = 3000 + Math.random() * 2000; // 3-5 seconds

  // Blink animation
  function blink() {
    const startTime = Date.now();
    
    function animate() {
      const elapsed = Date.now() - startTime;
      const progress = elapsed / blinkDuration;
      
      let eyeValue = 1.0;
      if (progress < 0.5) {
        eyeValue = 1.0 - (progress * 2);
      } else if (progress < 1.0) {
        eyeValue = (progress - 0.5) * 2;
      }
      
      // Mock implementation
      if (model.setParameterValueById) {
        model.setParameterValueById("eyeOpenLeft", eyeValue);
        model.setParameterValueById("eyeOpenRight", eyeValue);
      }
      
      if (model.update) {
        model.update();
      }
      
      if (progress < 1.0) {
        requestAnimationFrame(animate);
      } else {
        // Schedule next blink
        setTimeout(blink, blinkInterval);
      }
    }
    
    animate();
  }

  // Start blinking
  setTimeout(blink, blinkInterval);
}
