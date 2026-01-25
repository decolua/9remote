import { useRef, useEffect } from "react";

// Touch scroll with inertia for terminal
export function useTouchScroll(termRef, terminalElementRef, enabled = true) {
  const lastTouchYRef = useRef(0);
  const velocityRef = useRef(0);
  const scrollAccumulatorRef = useRef(0);
  const animationIdRef = useRef(null);
  const lastTimeRef = useRef(0);

  useEffect(() => {
    if (!enabled || !termRef.current || !terminalElementRef.current) return;

    const term = termRef.current;
    const termElement = terminalElementRef.current;
    const lineHeight = 16; // Approximate line height in pixels

    const handleTouchStart = (e) => {
      if (e.touches.length === 1) {
        // Stop any ongoing inertia animation
        if (animationIdRef.current) {
          cancelAnimationFrame(animationIdRef.current);
          animationIdRef.current = null;
        }
        lastTouchYRef.current = e.touches[0].clientY;
        lastTimeRef.current = performance.now();
        velocityRef.current = 0;
        scrollAccumulatorRef.current = 0;
      }
    };

    const handleTouchMove = (e) => {
      if (e.touches.length === 1) {
        const touchY = e.touches[0].clientY;
        const now = performance.now();
        const deltaY = lastTouchYRef.current - touchY;
        const deltaTime = now - lastTimeRef.current;

        // Smooth velocity calculation with averaging
        if (deltaTime > 0) {
          const newVelocity = deltaY / deltaTime;
          velocityRef.current = velocityRef.current * 0.7 + newVelocity * 0.3;
        }

        lastTouchYRef.current = touchY;
        lastTimeRef.current = now;

        // Accumulate scroll and apply when >= 1 line
        scrollAccumulatorRef.current += deltaY / lineHeight;
        const linesToScroll = Math.trunc(scrollAccumulatorRef.current);

        if (linesToScroll !== 0) {
          term.scrollLines(linesToScroll);
          scrollAccumulatorRef.current -= linesToScroll;
        }
      }
    };

    const handleTouchEnd = () => {
      // Apply inertia scrolling with smooth deceleration
      const friction = 0.92;
      const minVelocity = 0.005;

      const inertiaScroll = () => {
        if (Math.abs(velocityRef.current) < minVelocity) {
          animationIdRef.current = null;
          velocityRef.current = 0;
          scrollAccumulatorRef.current = 0;
          return;
        }

        // Calculate scroll based on velocity
        const deltaY = velocityRef.current * 16; // ~16ms per frame at 60fps
        scrollAccumulatorRef.current += deltaY / lineHeight;
        const linesToScroll = Math.trunc(scrollAccumulatorRef.current);

        if (linesToScroll !== 0) {
          term.scrollLines(linesToScroll);
          scrollAccumulatorRef.current -= linesToScroll;
        }

        velocityRef.current *= friction;
        animationIdRef.current = requestAnimationFrame(inertiaScroll);
      };

      if (Math.abs(velocityRef.current) > minVelocity) {
        animationIdRef.current = requestAnimationFrame(inertiaScroll);
      }
    };

    termElement.addEventListener("touchstart", handleTouchStart, { passive: true });
    termElement.addEventListener("touchmove", handleTouchMove, { passive: true });
    termElement.addEventListener("touchend", handleTouchEnd, { passive: true });

    return () => {
      termElement.removeEventListener("touchstart", handleTouchStart);
      termElement.removeEventListener("touchmove", handleTouchMove);
      termElement.removeEventListener("touchend", handleTouchEnd);
      if (animationIdRef.current) {
        cancelAnimationFrame(animationIdRef.current);
      }
    };
  }, [termRef, terminalElementRef, enabled]);
}
