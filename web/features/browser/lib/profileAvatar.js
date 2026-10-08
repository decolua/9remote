"use client";

// Chrome-style profile avatar: a colored disc with the profile's initial,
// the color stable per name so profiles stay tellable apart at a glance.
export function profileColor(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 62% 45%)`;
}

export function ProfileAvatar({ name, size = 20, className = "" }) {
  const label = (name === "default" ? "D" : name).trim().charAt(0).toUpperCase();
  return (
    <span
      className={`shrink-0 rounded-full flex items-center justify-center text-white font-bold ${className}`}
      style={{
        backgroundColor: profileColor(name),
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size / 2))
      }}
    >
      {label}
    </span>
  );
}
