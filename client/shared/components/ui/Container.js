"use client";

// Reusable page container with gradient background
export default function Container({ children, centered = true, className = "" }) {
  // const baseClasses = "min-h-screen bg-gradient-to-br from-dark-900 via-orange-700/20 to-dark-900/10";
  const baseClasses = 'min-h-screen'
  const centerClasses = centered ? "flex items-center justify-center p-4" : "";
  
  return (
    <div className={`${baseClasses} ${centerClasses} ${className}`}>
      {children}
    </div>
  );
}
