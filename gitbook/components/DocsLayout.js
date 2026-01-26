"use client";

import DocsHeader from "./DocsHeader";
import DocsSidebar from "./DocsSidebar";
import DocsToc from "./DocsToc";

export default function DocsLayout({ children, headings = [] }) {
  return (
    <div className="min-h-screen flex flex-col bg-[#FCFBF9]">
      <DocsHeader />
      <div className="flex-1 flex">
        {/* Desktop sidebar */}
        <div className="hidden lg:block">
          <DocsSidebar />
        </div>
        
        <div className="flex-1 flex">
          {children}
          <DocsToc headings={headings} />
        </div>
      </div>
    </div>
  );
}
