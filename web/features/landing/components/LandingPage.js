"use client";

import AnimatedBackground from "./AnimatedBackground";
import Navbar from "./Navbar";
import HeroSection from "./HeroSection";
import FeaturesSection from "./FeaturesSection";
import SecuritySection from "./SecuritySection";
import GetStartedSection from "./GetStartedSection";
import CTASection from "./CTASection";
import Footer from "./Footer";
import { THEME } from "../constants/landingConfig";

export default function LandingPage() {
  return (
    <div className="min-h-screen overflow-x-hidden safe-area-insets" style={{ color: THEME.text }}>
      <AnimatedBackground />
      <div className="landing-light" aria-hidden />
      <Navbar />
      <main className="relative z-10">
        <HeroSection />
        <FeaturesSection />
        <SecuritySection />
        <GetStartedSection />
        <CTASection />
      </main>
      <Footer />
    </div>
  );
}
