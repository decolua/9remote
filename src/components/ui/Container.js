"use client";

// Reusable page container with gradient background
export default function Container({ children, centered = true, className = "" }) {
  const baseClasses = "min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900";
  const centerClasses = centered ? "flex items-center justify-center p-4" : "";
  
  return (
    <div className={`${baseClasses} ${centerClasses} ${className}`}>
      {children}
    </div>
  );
}
