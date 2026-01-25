"use client";

// Reusable Button component with variants
export default function Button({ 
  children, 
  variant = "primary", 
  size = "md",
  disabled = false,
  loading = false,
  onClick,
  className = "",
  ...props 
}) {
  const baseClasses = "font-semibold rounded-lg transition transform active:scale-[0.98]";
  
  const variantClasses = {
    primary: "bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 text-white",
    secondary: "bg-slate-700 hover:bg-slate-600 disabled:bg-slate-600 text-white",
    danger: "bg-red-500 hover:bg-red-600 disabled:bg-slate-600 text-white",
    success: "bg-green-600 hover:bg-green-700 disabled:bg-slate-600 text-white"
  };
  
  const sizeClasses = {
    sm: "px-3 py-1.5 text-sm",
    md: "px-4 py-2 text-base",
    lg: "px-6 py-3 text-lg"
  };
  
  const classes = `${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${disabled || loading ? "cursor-not-allowed opacity-50" : "hover:scale-[1.02]"} ${className}`;
  
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={classes}
      {...props}
    >
      {loading ? (
        <span className="flex items-center justify-center gap-2">
          <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></span>
          {children}
        </span>
      ) : (
        children
      )}
    </button>
  );
}
