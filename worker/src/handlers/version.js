import { corsHeaders } from "../index.js";

export async function handleVersion(request, env) {
  const version = env.BUILD_VERSION || "0.1.7";
  const buildTime = env.BUILD_TIME || new Date().toISOString();

  return new Response(
    JSON.stringify({
      version,
      buildTime,
      minAppVersion: "0.1.0",
      forceUpdate: false
    }),
    {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    }
  );
}
