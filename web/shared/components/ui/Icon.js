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
  Lock,
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
  CornerDownLeft,
  Delete,
  Mic,
  MicOff,
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
  RotateCw,
  Play,
  Pause,
  Square,
  Pencil,
  StickyNote,
  SquarePen,
  ListChecks,
  Maximize2,
  Sparkles,
  Globe,
  Palette,
  Crown,
  CheckCircle2,
  GitBranch,
  FolderPlus,
  FilePlus,
  Paperclip,
  Home,
  HardDrive,
  Package,
  FileText,
  FileJson,
  FileCode,
  Image,
  Wallpaper,
  ImageOff,
  Menu,
  Share,
  Smartphone,
  MoreVertical,
  MoreHorizontal,
  GripVertical,
  QrCode,
  Send,
  SendHorizontal,
  ExternalLink,
  Link2,
  ChevronDown,
  ChevronsDownUp,
  ChevronUp,
  Bell,
  Bot,
  Zap,
  Keyboard,
  HelpCircle,
  ClipboardPaste,
  Undo2,
  MousePointer2,
  Hand,
  Users,
  Facebook,
  Github,
  Sun,
  Moon,
  LayoutDashboard,
  Shield,
  ArrowUp,
  ArrowDown,
  ArrowRight,
  Bug,
  Pin,
  PinOff,
  History,
  Files,
  PanelLeftOpen,
  PanelLeftClose,
  PanelLeft,
  PanelRight,
  GitFork,
  Filter,
  Replace,
  Command,
  Type,
  Triangle,
  Circle,
  Power,
  Volume2,
  VolumeX,
} = LucideIcons;
