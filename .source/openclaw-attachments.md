# OpenClaw Attachments (File/Image Upload)

## Tổng quan

OpenClaw hỗ trợ gửi file/image kèm theo message qua parameter `attachments` trong `chat.send` hoặc `agent` method.

**Supported formats:**
- Images: JPEG, PNG, WEBP, GIF, HEIC, HEIF
- Documents: PDF (text extraction)
- Max size: 5MB per file (configurable)

**Processing:**
- Files **< 2MB**: Passed inline to LLM as base64
- Files **> 2MB**: Offloaded to disk (`~/.openclaw/media/inbound/<id>`), replaced with `media://inbound/<id>` URI
- Agent resolves `media://` URIs before sending to model

---

## Attachment Format

```typescript
type ChatAttachment = {
  type?: string;           // Optional label (e.g., "image", "photo")
  mimeType?: string;       // MIME type (e.g., "image/jpeg", "application/pdf")
  fileName?: string;       // Original filename (e.g., "photo.jpg")
  content?: string;        // Base64-encoded file content (NO data URL prefix)
};
```

**Important:**
- `content` must be **pure base64** (NOT `data:image/jpeg;base64,...`)
- If you have a data URL, strip the prefix before sending
- OpenClaw will auto-detect MIME type from base64 magic bytes if `mimeType` is missing

---

## WebSocket API

### chat.send with attachments

```javascript
const idempotencyKey = randomUUID();

await client.request("chat.send", {
  sessionKey: "main",
  message: "What's in this image?",
  idempotencyKey,
  attachments: [
    {
      type: "image",
      mimeType: "image/jpeg",
      fileName: "photo.jpg",
      content: "<base64_string_here>"  // Pure base64, no prefix
    }
  ]
});
```

### agent method with attachments

```javascript
await client.request("agent", {
  message: "Analyze this document",
  agentId: "main",
  idempotencyKey: randomUUID(),
  attachments: [
    {
      type: "document",
      mimeType: "application/pdf",
      fileName: "report.pdf",
      content: "<base64_pdf>"
    }
  ]
});
```

---

## Processing Flow

```
Client
  ↓ Send base64 attachment
Agent (9remote)
  ↓ Validate size/type
  ↓ Forward to OpenClaw Gateway
OpenClaw Gateway
  ↓ Parse attachment
  ├─ Small (<2MB) → inline to model
  └─ Large (>2MB) → save to disk
       ↓ Generate media://inbound/<id>
       ↓ Append to message: "[media attached: media://inbound/<id>]"
Agent Runtime
  ↓ Resolve media:// URI → filesystem path
  ↓ Pass to LLM provider
LLM
  ↓ Process image/document
  ↓ Return response
```

---

## Node.js Example (9remote Agent)

### Receive from client via Socket.IO

```javascript
// In agent/lib/socketio.js
socket.on("chat:send", async ({ sessionKey = "main", message, attachments }) => {
  try {
    // Validate attachments
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        // Check size (estimate from base64 length)
        const sizeBytes = Math.ceil(att.content.length * 0.75);
        if (sizeBytes > 5_000_000) {
          socket.emit("chat:error", { error: `File ${att.fileName} exceeds 5MB limit` });
          return;
        }

        // Strip data URL prefix if present
        if (att.content.startsWith("data:")) {
          const match = /^data:[^;]+;base64,(.*)$/.exec(att.content);
          if (match) {
            att.content = match[1];
          }
        }
      }
    }

    // Forward to OpenClaw
    const openclawClient = getOpenClawClient();
    await openclawClient.chat(sessionKey, message, (delta) => {
      socket.emit("chat:delta", { text: delta });
    }, attachments);  // Pass attachments here

    socket.emit("chat:done");
  } catch (err) {
    socket.emit("chat:error", { error: err.message });
  }
});
```

### Update OpenClawClient class

```javascript
// In agent/features/openclaw/client.js
class OpenClawClient {
  async chat(sessionKey, message, onDelta, attachments = []) {
    const idempotencyKey = randomUUID();
    const requestId = randomUUID();

    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });

      let fullText = "";
      this.once(`chat:${requestId}`, (event) => {
        if (event.state === "delta") {
          fullText = event.message?.text || "";
          onDelta?.(fullText);
        } else if (event.state === "final") {
          resolve(fullText);
        } else if (event.state === "error") {
          reject(new Error(event.errorMessage || "Chat failed"));
        }
      });

      this.#send({
        id: requestId,
        method: "chat.send",
        params: {
          sessionKey,
          message,
          idempotencyKey,
          attachments  // Add attachments here
        }
      });
    });
  }
}
```

---

## React Example (9remote Web)

### File Upload Component

```jsx
// In web/shared/components/OpenClawChat.js
import { useCallback, useState } from "react";

function FileUpload({ onFilesSelected }) {
  const [previews, setPreviews] = useState([]);

  const handleFileChange = useCallback(async (e) => {
    const files = Array.from(e.target.files || []);
    const attachments = [];

    for (const file of files) {
      // Validate
      if (file.size > 5_000_000) {
        alert(`${file.name} exceeds 5MB limit`);
        continue;
      }

      // Convert to base64
      const base64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          // Strip data URL prefix
          const base64 = dataUrl.split(",")[1];
          resolve(base64);
        };
        reader.readAsDataURL(file);
      });

      attachments.push({
        type: file.type.startsWith("image/") ? "image" : "document",
        mimeType: file.type,
        fileName: file.name,
        content: base64
      });

      // Preview for images
      if (file.type.startsWith("image/")) {
        setPreviews((prev) => [...prev, { name: file.name, url: URL.createObjectURL(file) }]);
      }
    }

    onFilesSelected(attachments);
  }, [onFilesSelected]);

  const handlePaste = useCallback(async (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));

    if (imageItems.length === 0) return;

    e.preventDefault();
    const attachments = [];

    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;

      const base64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(",")[1]);
        reader.readAsDataURL(file);
      });

      attachments.push({
        type: "image",
        mimeType: file.type,
        fileName: `pasted-${Date.now()}.png`,
        content: base64
      });
    }

    onFilesSelected(attachments);
  }, [onFilesSelected]);

  return (
    <div onPaste={handlePaste}>
      <input
        type="file"
        accept="image/*,application/pdf"
        multiple
        onChange={handleFileChange}
      />
      <div className="previews">
        {previews.map((p, i) => (
          <img key={i} src={p.url} alt={p.name} style={{ width: 100, height: 100 }} />
        ))}
      </div>
    </div>
  );
}

export default function OpenClawChat() {
  const [attachments, setAttachments] = useState([]);

  const sendMessage = useCallback((text) => {
    socket.emit("chat:send", {
      sessionKey: "main",
      message: text,
      attachments  // Send attachments
    });
    setAttachments([]);  // Clear after send
  }, [attachments]);

  return (
    <div>
      <FileUpload onFilesSelected={setAttachments} />
      {/* ... chat UI ... */}
    </div>
  );
}
```

---

## OpenClaw Internal Processing

### Small files (<2MB)

```typescript
// Passed inline to model
{
  images: [
    {
      type: "image",
      data: "<base64>",
      mimeType: "image/jpeg"
    }
  ]
}
```

### Large files (>2MB)

```typescript
// Saved to disk, replaced with URI
message += "\n[media attached: media://inbound/abc123]";

offloadedRefs: [
  {
    mediaRef: "media://inbound/abc123",
    id: "abc123",
    path: "/Users/user/.openclaw/media/inbound/abc123.jpg",
    mimeType: "image/jpeg",
    label: "photo.jpg"
  }
]
```

Agent runtime resolves `media://inbound/abc123` → `/Users/user/.openclaw/media/inbound/abc123.jpg` before passing to model.

---

## Error Handling

### Client-side validation (4xx)

```javascript
// Invalid base64
throw new Error("attachment photo.jpg: invalid base64 content");

// Size limit
throw new Error("attachment photo.jpg: exceeds size limit (6000000 > 5000000 bytes)");

// Unsupported format
throw new Error("attachment doc.docx: only image/* supported");
```

### Server-side errors (5xx)

```javascript
// Disk full, permission denied, etc.
throw new MediaOffloadError("Failed to save intercepted media to disk: ENOSPC");
```

---

## Best Practices

1. **Always validate on client:** Check size/type before sending
2. **Strip data URL prefix:** OpenClaw expects pure base64
3. **Use descriptive filenames:** Helps AI understand context
4. **Compress large images:** Resize before upload to stay under 2MB for inline processing
5. **Handle errors gracefully:** Show user-friendly messages
6. **Preview before send:** Let user confirm what they're uploading
7. **Support paste:** Ctrl+V for quick image sharing
8. **Multi-file batching:** Allow selecting multiple files at once

---

## Limitations

- **Max size:** 5MB per file (configurable in OpenClaw)
- **Supported formats:** Images (JPEG, PNG, WEBP, GIF, HEIC, HEIF), PDF
- **No video/audio:** Not supported yet
- **No file storage in 9remote:** Agent is stateless, files go directly to OpenClaw
- **Model support:** Only vision-capable models can process images (GPT-4V, Claude 3, Gemini Pro Vision)

---

## Summary

- Client converts file → base64 → sends via Socket.IO
- Agent validates → forwards to OpenClaw
- OpenClaw handles inline (<2MB) or offload (>2MB)
- AI processes image/document → returns response
- No file storage needed in 9remote Agent
