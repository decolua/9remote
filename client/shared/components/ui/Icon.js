import * as LucideIcons from "lucide-react";

/**
 * Icon wrapper component for Lucide React icons
 * Provides consistent sizing and styling across the app
 */
export default function Icon({ name, size = 20, className = "", ...props }) {
  const IconComponent = LucideIcons[name];
  
  if (!IconComponent) {
    console.warn(`Icon "${name}" not found in lucide-react`);
    return null;
  }
  
  return (
    <IconComponent 
      size={size} 
      className={className}
      strokeWidth={2}
      {...props}
    />
  );
}

// Export commonly used icons for convenience
export const {
  X,
  Eye,
  EyeOff,
  LogIn,
  Trash2,
  Plus,
  Terminal,
  Monitor,
  FolderOpen,
  Settings,
  LogOut,
  ChevronLeft,
  ChevronRight,
  Check,
  AlertCircle,
  Loader2,
  Search,
  File,
  Folder,
  Save,
  Copy,
  Download,
  Upload,
  RefreshCw,
  Play,
  Pause,
  Stop,
  Pencil,
  Sparkles,
  Globe,
  Palette,
  GitBranch,
  FolderPlus,
  FilePlus,
} = LucideIcons;
