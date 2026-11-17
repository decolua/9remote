window.createColorScene = function (sceneNumber, duration = 20, showRecapAt = null) {
  const stage = document.querySelector(".stage");
  const visual = document.querySelector(".visual");
  const recap = document.querySelector(".recap");
  const dots = [...document.querySelectorAll(".progress-dot")];

  dots.forEach((dot, index) => {
    dot.classList.toggle("is-current", index === sceneNumber - 1);
  });

  return {
    duration,
    width: 1920,
    height: 1080,
    frame(t) {
      const time = Math.max(0, Math.min(duration, Number(t) || 0));
      const gentleLift = Math.sin(time * 0.9) * 8;
      const gentleTurn = Math.sin(time * 0.45) * 2.5;
      const pulse = 1 + Math.sin(time * 1.2) * 0.018;
      visual.style.setProperty("--lift", `${gentleLift}px`);
      visual.style.setProperty("--turn", `${gentleTurn}deg`);
      visual.style.setProperty("--pulse", pulse);

      if (showRecapAt !== null) {
        const visible = time >= showRecapAt;
        recap.style.opacity = visible ? "1" : "0";
        recap.style.transform = visible ? "translateY(0)" : "translateY(18px)";
      }

      stage.dataset.time = time.toFixed(3);
    }
  };
};
