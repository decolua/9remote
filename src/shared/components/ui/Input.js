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
  const baseClasses = "w-full px-4 py-3 bg-slate-900 border rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 transition";
  const borderClasses = error 
    ? "border-red-500 focus:border-red-500 focus:ring-red-500" 
    : "border-slate-600 focus:border-transparent focus:ring-blue-500";
  
  const classes = `${baseClasses} ${borderClasses} ${disabled ? "opacity-50 cursor-not-allowed" : ""} ${className}`;
  
  return (
    <div className="w-full">
      {label && (
        <label className="block text-sm font-medium text-slate-300 mb-2">
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
