// iOS 15.0–15.3 drop every rule nested in @layer (supported starting in 15.4).
function unwrapAtLayer() {
  return {
    postcssPlugin: "unwrap-at-layer",
    Once(root) {
      let pending = true;
      while (pending) {
        pending = false;
        root.walkAtRules("layer", (atRule) => {
          if (atRule.nodes) atRule.replaceWith(atRule.nodes);
          else atRule.remove();
          pending = true;
          return false;
        });
      }
    }
  };
}
unwrapAtLayer.postcss = true;

const config = {
  plugins: [
    ["@tailwindcss/postcss", {}],
    unwrapAtLayer()
  ]
};

export default config;
