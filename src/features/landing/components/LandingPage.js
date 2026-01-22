"use client";

import AnimatedBackground from "./AnimatedBackground";
import Navbar from "./Navbar";
import HeroSection from "./HeroSection";
import FeaturesSection from "./FeaturesSection";
import HowItWorksSection from "./HowItWorksSection";
import GetStartedSection from "./GetStartedSection";
import CTASection from "./CTASection";
import Footer from "./Footer";

export default function LandingPage() {
  return (
    <div className="min-h-screen text-white overflow-x-hidden" style={{ background: "#0a0e27" }}>
      <AnimatedBackground />
      <Navbar />
      <main className="relative z-10">
        <HeroSection />
        <FeaturesSection />
        <HowItWorksSection />
        <GetStartedSection />
        <CTASection />
      </main>
      <Footer />
    </div>
  );
}
