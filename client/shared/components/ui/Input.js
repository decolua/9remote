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
  const baseClasses = "w-full px-4 py-3 bg-dark-600 border rounded-brand text-white placeholder-dark-100 focus:outline-none focus:ring-2 transition-all duration-200";
  const borderClasses = error 
    ? "border-red-500 focus:border-red-500 focus:ring-red-500" 
    : "border-dark-400 focus:border-transparent focus:ring-brand-500";
  
  const classes = `${baseClasses} ${borderClasses} ${disabled ? "opacity-50 cursor-not-allowed" : ""} ${className}`;
  
  return (
    <div className="w-full">
      {label && (
        <label className="block text-sm font-medium text-dark-50 mb-2">
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
