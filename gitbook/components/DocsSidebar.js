"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOCS_CONFIG } from "@/constants/docsConfig";
import { ChevronDown, ChevronRight, BookOpen, Terminal, Monitor, FolderOpen, HelpCircle, MessageCircle, Smartphone, AppWindow, Layers, Shield, Compass, Server, Workflow, Bot, Globe, ShieldCheck } from "lucide-react";

const SECTION_ICONS = {
  "Getting Started": BookOpen,
  "Features": Terminal,
  "Native Apps": Smartphone,
  "Architecture": Layers,
  "Guides": Compass,
  "Help": HelpCircle,
  "Legal": ShieldCheck
};

const ITEM_ICONS = {
  "Introduction": BookOpen,
  "Terminal": Terminal,
  "AI & Agents": Bot,
  "Site Browser": Globe,
  "Remote Desktop": Monitor,
  "File Explorer": FolderOpen,
  "Desktop App": AppWindow,
  "Mobile App": Smartphone,
  "Architecture & Transport": Layers,
  "Security & Auth": Shield,
  "Background Services & Daemon": Server,
  "Advanced AI Workflow": Workflow,
  "Self-Hosting": Server,
  "Troubleshooting": HelpCircle,
  "FAQ": MessageCircle
};

export default function DocsSidebar({ isMobile = false, onClose }) {
  const pathname = usePathname();
  const [openSections, setOpenSections] = useState(
    DOCS_CONFIG.navigation.map((_, i) => i)
  );

  const toggleSection = (index) => {
    setOpenSections(prev =>
      prev.includes(index)
        ? prev.filter(i => i !== index)
        : [...prev, index]
    );
  };

  const isActive = (slug) => {
    if (slug === "getting-started" && pathname === "/") return true;
    return pathname === `/${slug}`;
  };

  const handleLinkClick = () => {
    if (isMobile && onClose) {
      onClose();
    }
  };

  return (
    <aside className={`${isMobile ? 'w-full' : 'w-64'} border-r bg-white border-gray-200 ${isMobile ? 'h-full' : 'h-[calc(100vh-4rem)] sticky top-16'} overflow-y-auto`}>
      <nav className="p-4 space-y-6">
        {DOCS_CONFIG.navigation.map((section, sectionIndex) => {
          const SectionIcon = SECTION_ICONS[section.title] || BookOpen;
          
          return (
            <div key={sectionIndex}>
              {/* Section title */}
              <button
                onClick={() => toggleSection(sectionIndex)}
                className="flex items-center justify-between w-full text-sm font-semibold text-gray-900 mb-2 hover:text-[#E68A6E] transition-colors"
              >
                <span className="flex items-center gap-2">
                  <SectionIcon className="w-4 h-4" />
                  {section.title}
                </span>
                {openSections.includes(sectionIndex) ? (
                  <ChevronDown className="w-4 h-4" />
                ) : (
                  <ChevronRight className="w-4 h-4" />
                )}
              </button>

              {/* Section items */}
              {openSections.includes(sectionIndex) && (
                <ul className="space-y-1">
                  {section.items.map((item, itemIndex) => {
                    const ItemIcon = ITEM_ICONS[item.title] || BookOpen;
                    
                    return (
                      <li key={itemIndex}>
                        <Link
                          href={item.slug === "getting-started" ? "/" : `/${item.slug}`}
                          onClick={handleLinkClick}
                          className={`flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors ${
                            isActive(item.slug)
                              ? "bg-[#E68A6E]/10 text-[#E68A6E] font-medium"
                              : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                          }`}
                        >
                          <ItemIcon className="w-4 h-4" />
                          {item.title}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
