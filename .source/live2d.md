# Live2D AI Chat — Integration Reference

Source: `.source/live_ai/`
Stack: Next.js 15, React 19, Tailwind CSS 4, PIXI.js v8, pixi-live2d-display, JavaScript (no TypeScript)

---

## 1. Architecture Overview

```
User message
  → POST /api/chat
      → OpenRouter (Llama 3.1) → AI response text + emotion + gesture
      → Bing TTS → base64 audio data URI
  → Response: { response, emotion, audioData }

Frontend:
  SimpleChatPanel → receives response
    → addMessage(text, emotion)
    → applyEmotionWithLipSync(emotion, audioData)
        → currentModel.motion(expressionMapping[emotion])
        → currentModel.startLipSyncFromBase64Audio(audioData)
            → Web Audio API → ParamMouthOpenY → 60fps loop
```

---

## 2. Stack & Dependencies

```json
"pixi.js": "^8.11.0",
"pixi-live2d-display": "^0.4.0",
"zustand": "^5.0.6"
```

**CDN scripts cần load trước PIXI:**
```html
<!-- Không cần CDN — PIXI load qua npm -->
```

---

## 3. Module Breakdown

### 3.1 Live2DViewer — `components/live2d/Live2DViewer.js`

**SDK:** `pixi.js` v8 + `pixi-live2d-display` — load qua npm, không cần CDN.

**Model format:** Cubism 3/4 — `.model3.json` (local files trong `public/models/`)

```js
// Load PIXI (client-side only)
import * as PIXI from "pixi.js"
import { Live2DModel } from "pixi-live2d-display"

// Setup canvas
const app = new PIXI.Application({
  view: canvasEl,
  backgroundAlpha: 0,   // transparent background
  resizeTo: window,
})

// Load model
const model = await Live2DModel.from("/models/25meiko_collabo01_t02/25meiko_collabo01_t02.model3.json")

// Scale + position
model.anchor.set(0.5, 1)
const widthScale = app.renderer.width / model.width * 0.95
const heightScale = app.renderer.height / model.height * 0.95
model.scale.set(widthScale * 1.3, heightScale)
model.x = app.renderer.width / 2
model.y = app.renderer.height - 40

app.stage.addChild(model)
```

**Model path convention:**
```
public/models/<modelName>/<modelName>.model3.json
```

**Background:** ảnh tuyệt đối qua `<img>` absolute, canvas relative z-index 10 phía trên.

**Available models (local):**
| Model | Path |
|---|---|
| `25meiko_collabo01_t02` | `/models/25meiko_collabo01_t02/25meiko_collabo01_t02.model3.json` |
| `01ichika_cloth001_3.1_f_t01` | `/models/01ichika_cloth001_3.1_f_t01/01ichika_cloth001_3.1_f_t01.model3.json` |

---

### 3.2 State — `store/live2dStore.js` (Zustand)

```js
{
  currentModel: null,        // PIXI Live2DModel instance
  selectedModel: "25meiko_collabo01_t02",
  modelLoading: false,
  modelError: null,
  availableMotions: [],
  availableExpressions: [],
}
```

---

### 3.3 Lip Sync — `lib/lipSync.js`

**Cách hoạt động:** Inject method `startLipSyncFromBase64Audio(dataUrl)` trực tiếp vào model instance.

```js
import { addLipSyncToModel } from "@/lib/lipSync"

// Gọi sau khi model load xong
addLipSyncToModel(model)

// Sau đó dùng:
await model.startLipSyncFromBase64Audio("data:audio/mpeg;base64,...")
```

**Bên trong `startLipSyncFromBase64Audio`:**
```
base64 data URL
  → base64AudioToBlob() → Blob
  → audioContext.decodeAudioData() → AudioBuffer
  → createBufferSource() → playbackRate: 1.15
  → AnalyserNode (fftSize: 512)
  → requestAnimationFrame loop
      → getByteTimeDomainData()
      → RMS calculation → volume (0–1)
      → model.internalModel.coreModel.setParameterValueById("ParamMouthOpenY", volume)
  → source.onended → reset ParamMouthOpenY = 0
```

**Reset mouth khi stop:**
```js
model.stopLipSync()
// → cancelAnimationFrame + setParameterValueById("ParamMouthOpenY", 0)
```

---

### 3.4 Emotion / Motion

**Mapping emotion string → Live2D motion name:**
```js
const expressionMapping = {
  angry:     "Angry",
  idle:      "Idle",
  sad:       "Sad",
  cry:       "Cry",
  smile:     "Smile",
  surprise:  "Surprise",
  baffling:  "Baffling",
  shakehead: "Shakehead"
}

// Áp dụng:
model.motion(expressionMapping[emotion] || "Idle")

// Reset về idle sau 2.5s:
setTimeout(() => model.motion("Idle"), 2500)
```

**Blink effect (tự động):**
```js
setInterval(() => {
  model.internalModel.coreModel.setParameterValueById("ParamEyeROpen", 0)
  model.internalModel.coreModel.setParameterValueById("ParamEyeLOpen", 0)
  setTimeout(() => {
    model.internalModel.coreModel.setParameterValueById("ParamEyeROpen", 1)
    model.internalModel.coreModel.setParameterValueById("ParamEyeLOpen", 1)
  }, 100)
}, 3000)
```

**Head tracking (focus):**
```js
setInterval(() => {
  model.focus(Math.random() * canvasWidth, Math.random() * canvasHeight)
}, 5000)
```

**Touch interaction:**
```js
model.interactive = true
model.on("pointerdown", () => model.alpha = 0.9)
model.on("pointerup", () => { triggerRandomEmotion(model); model.alpha = 1.0 })
```

---

### 3.5 TTS — `lib/bing-tts.js` + `app/api/tts/route.js`

Giống nhau với mô tả cũ. Server-side route để tránh CORS.

```js
// API route trả về:
{ success: true, audioData: "data:audio/mpeg;base64,..." }

// Client dùng:
model.startLipSyncFromBase64Audio(data.audioData)
```

---

### 3.6 Chat Panel layout

```
<div className="h-dvh w-full overflow-hidden">
  <div className="flex flex-col md:flex-row h-full">
    {/* Left: Viewer full height */}
    <div className="flex-1 relative">
      <Live2DViewer />          {/* canvas + background image */}
      <SimpleChatPanel />       {/* fixed bottom overlay */}
    </div>
  </div>
</div>
```

**SimpleChatPanel:** `position: fixed bottom-0 left-0 right-0 z-20`
- Messages list với gradient fade top
- Input + Send button + Stop TTS button (khi đang nói)

---

## 4. Cleanup

```js
// Khi component unmount:
useEffect(() => {
  return () => {
    if (appRef.current) {
      appRef.current.destroy(true)  // destroy PIXI app + canvas
    }
  }
}, [])
```

---

## 5. Integration Checklist (9remote)

```
lib/lipSync.js               → copy sang web/shared/lib/lipSync.js
public/models/<name>/        → copy model folder vào web/public/models/
npm install pixi.js pixi-live2d-display
```

**Live2DViewer props (9remote version):**
```js
<Live2DViewer
  modelName="25meiko_collabo01_t02"   // folder name in public/models/
  backgroundUrl="https://..."         // optional background image
  className=""
/>
```

**Lipsync usage (9remote):**
```js
// Sau khi nhận TTS audio từ agent:
const model = live2dModelRef.current
if (model?.startLipSyncFromBase64Audio) {
  await model.startLipSyncFromBase64Audio(`data:audio/mpeg;base64,${base64}`)
}
```

---

## 6. Known Limitations & Notes

| Item | Detail |
|---|---|
| PIXI v8 | Breaking changes từ v7. Dùng đúng v8 API (`new PIXI.Application({...})`, không dùng `PIXI.Application.create()`). |
| pixi-live2d-display | Cần import trước khi dùng `Live2DModel.from()`. Cubism 4 runtime được bundle sẵn. |
| Local models | Model files phải nằm trong `public/` để Next.js serve static. |
| Background | Dùng `<img>` absolute + canvas relative z-10 — không dùng CSS background-image vì canvas cần transparent. |
| SSR | `"use client"` bắt buộc. PIXI/Live2D không chạy server-side. |
| Cleanup | Phải gọi `app.destroy(true)` khi unmount để tránh memory leak và WebGL context leak. |
| Audio | `startLipSyncFromBase64Audio` nhận full data URI (`data:audio/mpeg;base64,...`). |
| CORS | Bing TTS phải gọi từ server-side route. |
