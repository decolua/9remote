"use client";

import { useEffect, useRef, useState } from "react";
import { addLipSyncToModel } from "@/shared/lib/lipSync";

const DEFAULT_MODEL = "25meiko_collabo01_t02";
const DEFAULT_BG = "https://i.pinimg.com/736x/ff/aa/93/ffaa936a65c08b9970bb87b31af283d2.jpg";

export default function Live2DViewer({ modelName = DEFAULT_MODEL, backgroundUrl = DEFAULT_BG, emotion, canvasRef: externalCanvasRef, className = "" }) {
  const canvasRef = useRef(null);
  const appRef = useRef(null);
  const modelRef = useRef(null);
  const [isReady, setIsReady] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  // Wait for window.PIXI (loaded via CDN Script beforeInteractive)
  useEffect(() => {
    const check = () => {
      if (window.PIXI && window.PIXI.live2d) {
        setIsReady(true);
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  }, []);

  // Load model when PIXI ready
  useEffect(() => {
    if (!isReady || !canvasRef.current) return;
    let cancelled = false;

    const loadModel = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const PIXI = window.PIXI;

        // Destroy previous app
        if (appRef.current) {
          appRef.current.destroy(true);
          appRef.current = null;
          modelRef.current = null;
        }

        const app = new PIXI.Application({
          view: canvasRef.current,
          backgroundAlpha: 0,
          resizeTo: canvasRef.current.parentElement || window,
        });
        appRef.current = app;

        const modelUrl = `/models/${modelName}/${modelName}.model3.json`;
        console.log("Loading Live2D model:", modelUrl);

        const model = await PIXI.live2d.Live2DModel.from(modelUrl);
        if (cancelled) return;

        modelRef.current = model;

        // Add lipsync methods
        addLipSyncToModel(model);

        // Scale + position
        const w = app.renderer.width;
        const h = app.renderer.height;
        const isMobile = w < 768;
        const scaleX = (w / model.width) * 0.95 * (isMobile ? 1.5 : 1.3);
        const scaleY = (h / model.height) * 0.95;
        model.anchor.set(0.5, 1);
        model.scale.set(scaleX, scaleY);
        model.x = w / 2;
        model.y = h - 40;

        app.stage.addChild(model);

        // Auto blink
        setInterval(() => {
          try {
            model.internalModel.coreModel.setParameterValueById("ParamEyeROpen", 0);
            model.internalModel.coreModel.setParameterValueById("ParamEyeLOpen", 0);
            setTimeout(() => {
              model.internalModel.coreModel.setParameterValueById("ParamEyeROpen", 1);
              model.internalModel.coreModel.setParameterValueById("ParamEyeLOpen", 1);
            }, 100);
          } catch {}
        }, 3000);

        // Head tracking
        setInterval(() => {
          try { model.focus(Math.random() * w, Math.random() * h); } catch {}
        }, 5000);

        // Touch: random emotion
        model.interactive = true;
        model.cursor = "pointer";
        model.on("pointerup", () => {
          const motions = ["Sad", "Baffling", "Shakehead"];
          try {
            model.motion(motions[Math.floor(Math.random() * motions.length)]);
            setTimeout(() => model.motion("Idle"), 2500);
          } catch {}
        });

        // Expose model for parent (lipsync)
        if (canvasRef.current) canvasRef.current._live2dModel = model;
        if (externalCanvasRef) externalCanvasRef.current = canvasRef.current;

        setIsLoading(false);
        console.log("Live2D model loaded:", modelName);
      } catch (err) {
        if (!cancelled) {
          console.error("Live2D load error:", err);
          setError(err.message);
          setIsLoading(false);
        }
      }
    };

    loadModel();
    return () => { cancelled = true; };
  }, [isReady, modelName]);

  // Emotion → motion
  useEffect(() => {
    const model = modelRef.current;
    if (!model || !emotion) return;
    const map = { happy: "Smile", sad: "Sad", surprised: "Surprise", thinking: "Baffling", idle: "Idle" };
    try { model.motion(map[emotion] || "Idle"); } catch {}
  }, [emotion]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (appRef.current) {
        appRef.current.destroy(true);
        appRef.current = null;
      }
    };
  }, []);

  return (
    <div className={`relative w-full h-full ${className}`}>
      {/* Background image */}
      {backgroundUrl && (
        <img src={backgroundUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
      )}
      <div className="absolute inset-0 bg-black/10" />

      {/* PIXI canvas */}
      <canvas
        ref={canvasRef}
        className="relative w-full h-full z-10"
        style={{ display: "block" }}
      />

      {/* Loading */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-20">
          <div className="text-center text-white">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto mb-3" />
            <p className="text-sm">Đang tải model...</p>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-red-900/50 z-20">
          <div className="text-center text-white p-4">
            <p className="font-semibold mb-2">Lỗi tải model</p>
            <p className="text-sm opacity-80">{error}</p>
          </div>
        </div>
      )}
    </div>
  );
}
