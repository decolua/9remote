"use client";

// Reusable Spinner/Loading component
export default function Spinner({ size = "md", text, className = "" }) {
  const sizeClasses = {
    sm: "h-4 w-4 border-2",
    md: "h-8 w-8 border-2",
    lg: "h-12 w-12 border-b-2"
  };
  
  return (
    <div className={`flex flex-col items-center justify-center gap-3 ${className}`}>
      <div className={`animate-spin rounded-full border-brand-500 border-t-transparent ${sizeClasses[size]}`}></div>
      {text && <p className="text-brand-500 text-sm font-medium">{text}</p>}
    </div>
  );
}
