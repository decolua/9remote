"use client";

import { memo, useEffect, useState } from "react";
import { ImageLightbox } from "./ImageLightbox";

// A thumbnail row, not a list of names. The picture is read from the host on demand —
// the bytes never ride the event stream, where one screenshot is bigger than a whole
// replay window — and the same host door the file explorer uses scales it down first.
//
// The path is the whole contract: a tool call names the file it touched and the client
// reads it back. Nothing here knows which engine produced the call, so every adapter
// that reports its input gets pictures for free.
const THUMB_MAX = 4;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

function Thumb({ img, fileBus, onOpen }) {
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!img.path || !fileBus?.readMedia) return;
    let live = true;
    fileBus.readMedia(img.path).then((res) => {
      if (!live) return;
      if (res?.success && res.dataUrl) setSrc(res.dataUrl);
      else setFailed(true);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [img.path, fileBus]);

  // The file moved or cannot be read: draw nothing rather than a placeholder that lies.
  if (!img.path || failed) return null;

  return (
    <button
      type="button"
      onClick={() => onOpen?.(img)}
      className="h-[72px] w-[104px] shrink-0 overflow-hidden rounded-brand border border-border-subtle/60 bg-surface-2 transition-opacity hover:opacity-90 focus:outline-none focus:ring-1 focus:ring-brand-500"
      title={img.name}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={img.name} className="h-full w-full object-cover" draggable={false} />
      ) : (
        <span className="block h-full w-full animate-pulse bg-surface-3/40" />
      )}
    </button>
  );
}

/**
 * One thumbnail inside the reply bubble. A press opens the file in the editor's own
 * image viewer — the app already has one surface for looking at a picture, and a
 * second full-screen overlay on top of a chat read as noise.
 */
export const TurnImageThumb = memo(function TurnImageThumb({ img, fileBus = null, images = null, index = 0 }) {
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);
  const [viewing, setViewing] = useState(false);

  useEffect(() => {
    if (!img?.path || !fileBus?.readMedia) return;
    let live = true;
    fileBus.readMedia(img.path).then((res) => {
      if (!live) return;
      if (res?.success && res.dataUrl) setSrc(res.dataUrl);
      else setFailed(true);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [img?.path, fileBus]);

  if (!img?.path || failed) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setViewing(true)}
        className="h-[64px] w-[92px] shrink-0 overflow-hidden rounded-brand border border-border-subtle/60 bg-surface-2/60 transition-opacity hover:opacity-90"
        title={`${img.name} — open in viewer`}
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={img.name} className="h-full w-full object-cover" draggable={false} />
        ) : (
          <span className="block h-full w-full animate-pulse bg-surface-3/40" />
        )}
      </button>
      {viewing && (
        <ImageLightbox
          images={images || [img]}
          index={images ? index : 0}
          fileBus={fileBus}
          onClose={() => setViewing(false)}
        />
      )}
    </>
  );
});

export const TurnImages = memo(function TurnImages({ images = [], fileBus = null, onOpen }) {
  const [expanded, setExpanded] = useState(false);
  const [viewAt, setViewAt] = useState(null);

  if (!images.length) return null;

  const shown = expanded ? images : images.slice(0, THUMB_MAX);
  const rest = images.length - THUMB_MAX;

  const open = (img) => {
    if (onOpen) { onOpen(img.path); return; }
    setViewAt(images.indexOf(img));
  };

  return (
    <>
      <div className="my-2 flex flex-wrap items-center gap-1.5 pl-2.5">
        {shown.map((img, i) => (
          <Thumb key={`${img.path || img.name}-${i}`} img={img} fileBus={fileBus} onOpen={open} />
        ))}
        {!expanded && rest > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="h-[72px] w-[104px] shrink-0 rounded-brand border border-border-subtle/60 bg-surface-2 font-mono text-xs text-text-muted hover:text-text"
          >
            +{rest}
          </button>
        )}
        {expanded && rest > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="ml-0.5 shrink-0 font-mono text-[10px] text-text-subtle hover:text-text"
          >
            show less
          </button>
        )}
      </div>

      {viewAt != null && (
        <ImageLightbox images={images} index={viewAt} fileBus={fileBus} onClose={() => setViewAt(null)} />
      )}
    </>
  );
});

export { IMAGE_EXT };
export default TurnImages;
