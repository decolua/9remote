"use client";

const BACKGROUND_IMAGE_URL = "https://w0.peakpx.com/wallpaper/639/3/HD-wallpaper-dark-lines-black-dark-super-background-lines-navy-blue-thumbnail.jpg";

/**
 * Mobile background image - renders as fixed background layer
 * Does NOT wrap children to avoid re-render issues
 */
export default function MobileBackgroundImage() {
  return (
    <div 
      className="fixed inset-0 -z-10 md:hidden pointer-events-none"
      style={{
        backgroundImage: `url(${BACKGROUND_IMAGE_URL})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
        backgroundAttachment: "fixed"
      }}
    />
  );
}
