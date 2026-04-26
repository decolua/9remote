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
  const baseClasses = "font-semibold rounded-brand transition-all duration-150 ease-out transform active:scale-[0.97]";
  
  const variantClasses = {
    primary: "bg-brand-500 hover:bg-brand-600 disabled:bg-surface-3 disabled:text-text-muted text-white shadow-sm",
    secondary: "bg-surface-2 hover:bg-surface-3 disabled:bg-surface disabled:text-text-muted text-text",
    danger: "bg-red-500 hover:bg-red-600 disabled:bg-surface-3 disabled:text-text-muted text-white",
    success: "bg-green-600 hover:bg-green-700 disabled:bg-surface-3 disabled:text-text-muted text-white"
  };
  
  const sizeClasses = {
    sm: "px-3 py-1.5 text-sm",
    md: "px-4 py-2 text-base",
    lg: "px-6 py-3 text-lg"
  };
  
  const classes = `${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${disabled || loading ? "cursor-not-allowed" : ""} ${className}`;
  
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
