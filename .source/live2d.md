# Live2D AI Chat — Integration Reference

Source: `.source/live2d_ai/`
Stack: Next.js 15, React 19, Tailwind CSS 4, JavaScript (no TypeScript)

---

## 1. Architecture Overview

```
User message
  → POST /api/chat
      → OpenRouter (Llama 3.1) → AI response text
      → OpenRouter (Llama 3.1) → emotion + gesture JSON
      → Bing TTS → base64 audio
  → Response: { response, emotion, gesture, audioBase64, mimeType }

Frontend:
  ChatInterface → receives response
    → updates chatHistory state
    → calls onMessageSent({ emotion, gesture, audioBase64 })
    → plays audio → LipsyncEngine → Live2DViewer mouth params
  Dashboard → passes emotion + gesture to Live2DViewer
  Live2DViewer → sets expression + motion on L2Dwidget model
```

---

## 2. Module Breakdown

### 2.1 Avatar — `lib/live2d-manager.js` + `components/ui/Live2DViewer.js`

**SDK:** `live2d-widget@3.x` loaded dynamically from CDN at runtime.

```js
// Load SDK (once)
script.src = "https://cdn.jsdelivr.net/npm/live2d-widget@3.x/lib/L2Dwidget.min.js"

// Init model
window.L2Dwidget.init({
  model: { use: "<CDN_URL>/<path>/model.json" },
  display: { position: "relative", width: "100%", height: "100%" }
})
```

**Model sources (CDN, no local files needed):**

| Source key | Base URL |
|---|---|
| `EVRSTR` | `https://cdn.jsdelivr.net/gh/evrstr/live2d-widget-models/live2d_evrstr` |
| `ICHARLESZ` | `https://raw.githubusercontent.com/iCharlesZ/vscode-live2d-models/master/model-library` |
| `NOVA1751` | `https://nova1751.github.io/live2d-api/model` |
| `LOCAL` | `/live2d/models` |

**22 models available** — default: `pio`

| Category | Models |
|---|---|
| girls-frontline | hk416, ump45, ump9, wa2000 |
| vocaloid | miku, snow_miku |
| anime | rem, kurumi, platelet, madoka, mikoto, kuroko |
| cute | shizuku, chitose, koharu |
| potion-maker | pio, tia |
| special | epsilon |
| bilibili | bilibili_22, bilibili_33 |

**Emotion → Expression mapping:**

```js
// L2Dwidget expression IDs
const expressionMap = {
  happy:     "f01",
  sad:       "f02",
  surprised: "f03",
  thinking:  "f04",
  idle:      null   // no expression change
}

window.L2Dwidget.model.setExpression(expressionId)
```

**Gesture → Motion mapping:**

```js
const motionMap = {
  wave:  "tapBody",
  nod:   "idle",
  shake: "shake"
}

window.L2Dwidget.model.startMotion(motionName, 0, 3)
```

**Component props:**

```js
<Live2DViewer
  emotion="happy"          // idle | happy | sad | surprised | thinking
  gesture="wave"           // nod | shake | wave | null
  onGestureComplete={fn}   // callback after gesture animation (~2000ms)
  modelId="pio"            // any model id from LIVE2D_MODELS
/>
```

**Helper functions (live2d-manager.js):**

```js
getModelById(id)              // → model object | null
getModelUrl(model)            // → full CDN URL string
getModelsByCategory(cat)      // → filtered array
getRandomModel(excludeId)     // → random model object
getCategories()               // → sorted category array
loadLive2DModel(modelId)      // → Promise<{ success, model, data, url }>
preloadModels([ids])          // → Promise<{ success[], failed[] }>
```

---

### 2.2 Chat — `lib/openrouter.js` + `app/api/chat/route.js`

**Two sequential OpenRouter calls per message:**

1. **Chat call** — generates AI response text
   - Model: `meta-llama/llama-3.1-8b-instruct:free`
   - max_tokens: 150, temperature: 0.7
   - System prompt: friendly AI, Vietnamese/English

2. **Emotion analysis call** — analyzes the AI response
   - Model: same free model
   - max_tokens: 100, temperature: 0.3
   - Returns JSON: `{ "emotion": "happy", "gesture": "wave" }`

```js
// Usage
import { getChatResponse } from "@/lib/openrouter.js"
const result = await getChatResponse(userMessage, process.env.OPENROUTER_API_KEY)
// result: { response: string, emotion: string, gesture: string|null }
```

**Emotion analysis prompt template:**

```
Analyze the emotion and suggest a gesture for this text: "<AI response>"
Available emotions: idle, happy, sad, surprised, thinking
Available gestures: nod, shake, wave, null
Respond ONLY with JSON format: {"emotion": "...", "gesture": "..."}
```

**API endpoint:** `POST /api/chat`

```js
// Request
{ "message": "string" }

// Response
{
  "response":    "string",          // AI text
  "emotion":     "idle|happy|...",  // detected emotion
  "gesture":     "nod|shake|wave|null",
  "audioBase64": "string",          // base64 mp3 (without data: prefix)
  "mimeType":    "audio/mpeg",
  "error":       null
}
```

**Env required:**

```bash
OPENROUTER_API_KEY=sk-or-v1-...
```

---

### 2.3 Audio / TTS — `lib/bing-tts.js` + `app/api/tts/route.js`

**Bing TTS is completely free — no API key needed.**

**How it works:**
1. Scrape token from `https://www.bing.com/translator` (HTML parse)
2. POST SSML to `https://www.bing.com/tfettts` with token
3. Receive MP3 binary → convert to base64

**Token expires every ~26 minutes** — must re-fetch per request (or cache with TTL).

```js
import { getToken, getAudio, VIETNAMESE_VOICES } from "@/lib/bing-tts.js"

const token = await getToken()
// token: { key: string, token: string } | { error: string }

const result = await getAudio(VIETNAMESE_VOICES.FEMALE_1, text, token)
// result: { data: "data:audio/mpeg;base64,..." } | { error: string }
```

**Available Vietnamese voices:**

```js
VIETNAMESE_VOICES = {
  FEMALE_1: "vi-VN-HoaiMyNeural",   // default
  FEMALE_2: "vi-VN-NamMinhNeural",  // mislabeled, actually same
  MALE_1:   "vi-VN-NamMinhNeural"
}
```

**SSML template used:**

```xml
<speak version='1.0' xml:lang='en-US'>
  <voice xml:lang='vi-VN' xml:gender='Female' name='{voiceId}'>
    <prosody rate='0.00%'>{text}</prosody>
  </voice>
</speak>
```

**API endpoint:** `POST /api/tts`

```js
// Request
{ "text": "string", "voiceId": "vi-VN-HoaiMyNeural" }  // voiceId optional

// Response
{
  "audioBase64":   "string",   // base64 only (no data: prefix)
  "fullAudioData": "string",   // full data URL (for lipsync)
  "mimeType":      "audio/mpeg",
  "lipsyncEnabled": true,
  "error": null
}
```

**GET /api/tts** returns available voices list.

---

### 2.4 LipSync Engine — `lib/lipsync-engine.js`

**Uses Web Audio API — client-side only.**

```
Audio element
  → AudioContext.createMediaElementSource()
  → AnalyserNode (fftSize: 512, smoothingTimeConstant: 0.3)
  → requestAnimationFrame loop
      → getByteFrequencyData() → Uint8Array
      → filter speech range: 85Hz–2000Hz
      → RMS calculation → mouthValue (0–1)
      → smooth: value = lastValue*(1-α) + newValue*α
  → model.setParameterValueById("ParamMouthOpenY", mouthValue)
  → model.setParameterValueById("ParamMouthForm", mouthValue * 0.3)
```

**Live2D mouth parameters written:**
- `ParamMouthOpenY` — main open/close (0–1)
- `ParamMouthForm` — shape (value × 0.3)
- `mouthOpenY` — alternate name fallback
- `mouthForm` — alternate name fallback

**Default config:**

```js
sensitivity    = 2.0   // range: 0.5–5.0
smoothingFactor = 0.3  // range: 0.1–0.9
threshold      = 10    // range: 0–50 (noise floor)
```

**Live2DViewer sets on init:**

```js
configureLipsync({ sensitivity: 2.5, smoothing: 0.4, threshold: 8 })
```

**Key functions:**

```js
import {
  startLipsyncWithAudio,   // (live2dModel, htmlAudioElement) → void
  startLipsyncWithBase64,  // (live2dModel, base64String) → Promise<HTMLAudioElement>
  stopLipsync,             // () → void
  configureLipsync,        // ({ sensitivity, smoothing, threshold }) → void
  getLipsyncStatus         // () → { isActive, hasModel, lastMouthValue, ... }
} from "@/lib/lipsync-engine.js"
```

**Usage in ChatInterface (actual pattern):**

```js
const audio = new Audio()
audio.src = URL.createObjectURL(base64ToBlob(audioBase64, "audio/mpeg"))

const live2dModel = window.L2Dwidget?.model || null
if (live2dModel) {
  startLipsyncWithAudio(live2dModel, audio)
}
audio.play()

audio.onended = () => {
  stopLipsync()
  URL.revokeObjectURL(audio.src)
}
```

**Performance:**
- Audio latency: < 20ms
- CPU: minimal (optimized FFT)
- Memory: < 2MB additional
- Frame rate: 60 FPS via requestAnimationFrame

---

### 2.5 Expression System — `lib/expressions.js` + `types/index.js`

**Constants:**

```js
// types/index.js
EMOTIONS  = { IDLE, HAPPY, SAD, SURPRISED, THINKING }
GESTURES  = { NOD, SHAKE, WAVE }
```

**Parameter mappings (used for manual/programmatic control):**

```js
EXPRESSION_MAPPINGS = {
  idle:      { eyeOpenLeft: 1.0, eyeOpenRight: 1.0, eyeBrowLeftY: 0, mouthForm: 0, mouthOpenY: 0 },
  happy:     { eyeOpenLeft: 0.6, eyeOpenRight: 0.6, eyeBrowLeftY: -0.3, mouthForm: 1.0, mouthOpenY: 0.3 },
  sad:       { eyeOpenLeft: 0.8, eyeOpenRight: 0.8, eyeBrowLeftY: 0.5, mouthForm: -0.8, mouthOpenY: 0 },
  surprised: { eyeOpenLeft: 1.5, eyeOpenRight: 1.5, eyeBrowLeftY: -0.8, mouthForm: 0, mouthOpenY: 0.8 },
  thinking:  { eyeOpenLeft: 0.5, eyeOpenRight: 1.0, eyeBrowLeftY: 0.3, mouthForm: -0.3, mouthOpenY: 0 }
}
```

**Key functions:**

```js
applyExpression(model, emotion, intensity=1.0)
// → sets params on model, calls model.update()

transitionExpression(model, fromEmotion, toEmotion, duration=500)
// → smooth interpolation with ease-out cubic

playGesture(model, gesture, onComplete)
// → keyframe animation via requestAnimationFrame

playIdleAnimation(model)
// → random blink every 3–5s
```

**Gesture keyframes:**

```js
NOD:   duration 1000ms — angleY: 0 → 15 → -5 → 0
SHAKE: duration 1200ms — angleY: 0 → -20 → 20 → -15 → 0
WAVE:  duration 2000ms — armRightY: 0 → -30 → -10 → -30 → -10 → 0
```

> ⚠️ Note: these are designed for direct Live2D SDK model instances. L2Dwidget maps differently — emotion uses `setExpression()` and gesture uses `startMotion()` instead (see Section 2.1).

---

### 2.6 Dashboard — `components/layout/Dashboard.js`

**State managed at Dashboard level:**

```js
const [currentEmotion, setCurrentEmotion] = useState("idle")
const [currentGesture, setCurrentGesture] = useState(null)
const [isProcessing, setIsProcessing] = useState(false)
const [currentModelId, setCurrentModelId] = useState("pio")
```

**handleMessageSent callback (from ChatInterface → Dashboard → Live2DViewer):**

```js
const handleMessageSent = ({ emotion, gesture }) => {
  setIsProcessing(true)
  if (emotion) setCurrentEmotion(emotion)
  if (gesture) setCurrentGesture(gesture)
  setTimeout(() => setIsProcessing(false), 2000)
}
```

**Layout: 2-column grid**
- Left: Live2DViewer (emotion, gesture, modelId props)
- Right: ChatInterface (onMessageSent callback)
- Floating: ModelGallery (onModelSelect → setCurrentModelId)

---

### 2.7 ModelGallery — `components/ui/ModelGallery.js`

- Floating trigger button (bottom-right, fixed)
- Modal overlay with category filter tabs
- Grid of model cards (2–5 cols responsive)
- Props: `onModelSelect(modelId)`, `currentModelId`

---

## 3. Data Flow (Full)

```
[User types message]
        ↓
ChatInterface.handleSubmit()
        ↓
POST /api/chat  { message }
        ↓
  openrouter.getChatResponse()
    → call 1: AI chat response text
    → call 2: emotion analysis → { emotion, gesture }
  bing-tts.getToken() → bing-tts.getAudio()
        ↓
  Response: { response, emotion, gesture, audioBase64 }
        ↓
ChatInterface receives response:
  ├─ appends AI message to chatHistory
  ├─ calls onMessageSent({ emotion, gesture, audioBase64 })
  │     → Dashboard.handleMessageSent()
  │         → setCurrentEmotion(emotion)
  │         → setCurrentGesture(gesture)
  │         → passed as props to Live2DViewer
  │             → L2Dwidget.model.setExpression(expressionId)
  │             → L2Dwidget.model.startMotion(motionName)
  └─ playAudio(audioBase64)
        → HTMLAudioElement
        → LipsyncEngine.connectAudioSource(audioEl)
        → LipsyncEngine.startLipsync(L2Dwidget.model)
        → audio.play()
        → [60fps loop] → setParameterValueById("ParamMouthOpenY", value)
        → audio.onended → stopLipsync()
```

---

## 4. Integration Checklist

When integrating into your app, you need:

### Required files to copy:
```
lib/bing-tts.js          → TTS engine (free, no API key)
lib/openrouter.js        → AI chat + emotion analysis
lib/lipsync-engine.js    → real-time lipsync
lib/live2d-manager.js    → model catalog + loader
lib/expressions.js       → expression/gesture mappings
types/index.js           → EMOTIONS, GESTURES constants
app/api/chat/route.js    → chat endpoint
app/api/tts/route.js     → TTS endpoint
components/ui/Live2DViewer.js
components/ui/ChatInterface.js
components/ui/ModelGallery.js
```

### Environment:
```bash
OPENROUTER_API_KEY=sk-or-v1-...
# No TTS key needed
```

### Dependencies:
```json
"next": "15.x",
"react": "^19",
"axios": "^1.10.0",
"tailwindcss": "^4"
```

### CDN script (auto-loaded by Live2DViewer):
```
https://cdn.jsdelivr.net/npm/live2d-widget@3.x/lib/L2Dwidget.min.js
```

---

## 5. Known Limitations & Notes

| Item | Detail |
|---|---|
| Live2D SDK | Uses `L2Dwidget` v3 (not official Cubism SDK). Limited expression control — only `setExpression(id)` and `startMotion()`. |
| Bing TTS token | Scrapes from `bing.com/translator` HTML — fragile, can break if Bing changes their page. Token expires in ~26 min. |
| Emotion analysis | Adds a second OpenRouter API call per message (latency ~+500ms). Uses free model — less accurate than paid. |
| Lipsync | Requires `window.L2Dwidget.model` to be available (set after model loads). 1s delay on init to wait for model ready. |
| Audio | Uses `base64 → Blob → ObjectURL` pattern. Must call `URL.revokeObjectURL()` after playback to avoid memory leaks. |
| Model expressions | Not all CDN models support `f01–f04` expressions. Silent fail with `console.log("Expression not supported")`. |
| CORS | Bing TTS requests must go through server-side API route (not client-side) due to CORS restrictions. |
