"use client";

import AnimatedBackground from "./AnimatedBackground";
import Navbar from "./Navbar";
import HeroSection from "./HeroSection";
import FeaturesSection from "./FeaturesSection";
import TerminalDemoSection from "./TerminalDemoSection";
import GetStartedSection from "./GetStartedSection";
import CTASection from "./CTASection";
import Footer from "./Footer";

export default function LandingPage() {
  return (
    <div className="min-h-screen text-gray-900 overflow-x-hidden safe-area-insets" style={{ background: "#FFFFFF" }}>
      <AnimatedBackground />
      <Navbar />
      <main className="relative z-10">
        <HeroSection />
        <FeaturesSection />
        <TerminalDemoSection />
        <GetStartedSection />
        <CTASection />
      </main>
      <Footer />
    </div>
  );
}
