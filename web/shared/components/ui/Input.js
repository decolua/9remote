"use client";

// Reusable Input component
export default function Input({ 
  label,
  type = "text",
  value,
  onChange,
  onKeyDown,
  placeholder,
  disabled = false,
  error,
  className = "",
  ...props 
}) {
  const baseClasses = "w-full px-4 py-3 bg-surface-2 rounded-brand text-text placeholder-text-muted focus:outline-none transition-all duration-150 ease-out";
  const borderClasses = error 
    ? "ring-1 ring-red-500 focus:ring-2 focus:ring-red-500" 
    : "focus:ring-2 focus:ring-brand-500/40";
  
  const classes = `${baseClasses} ${borderClasses} ${disabled ? "opacity-50 cursor-not-allowed" : ""} ${className}`;
  
  return (
    <div className="w-full">
      {label && (
        <label className="block text-sm font-medium text-text mb-2">
          {label}
        </label>
      )}
      <input
        type={type}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        className={classes}
        {...props}
      />
      {error && (
        <p className="mt-1 text-sm text-red-400">{error}</p>
      )}
    </div>
  );
}
