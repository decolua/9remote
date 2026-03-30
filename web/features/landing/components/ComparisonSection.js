"use client";

export default function ComparisonSection() {
  const features = [
    { name: "Zero Config", nine: true, claude: true, teamviewer: true, chrome: true, termius: false },
    { name: "Terminal Access", nine: true, claude: true, teamviewer: false, chrome: false, termius: true },
    { name: "Remote Desktop", nine: true, claude: false, teamviewer: true, chrome: true, termius: false },
    { name: "File Explorer", nine: true, claude: false, teamviewer: true, chrome: false, termius: true },
    { name: "Code Editor", nine: true, claude: false, teamviewer: false, chrome: false, termius: false },
    { name: "Git Integration", nine: true, claude: false, teamviewer: false, chrome: false, termius: false },
    { name: "Mobile Optimized", nine: true, claude: true, teamviewer: false, chrome: false, termius: true },
    { name: "Browser-Based", nine: true, claude: true, teamviewer: false, chrome: true, termius: false },
    { name: "QR Login", nine: true, claude: true, teamviewer: false, chrome: false, termius: false },
    { name: "Auto Tunnel", nine: true, claude: true, teamviewer: true, chrome: true, termius: false },
    { name: "Persistent Sessions", nine: true, claude: true, teamviewer: false, chrome: false, termius: true },
    { name: "Multi-Device Sync", nine: true, claude: true, teamviewer: true, chrome: false, termius: true },
    { name: "Push Notifications", nine: true, claude: true, teamviewer: false, chrome: false, termius: false },
    { name: "AI Integration", nine: true, claude: true, teamviewer: false, chrome: false, termius: false },
    { name: "No Port Forwarding", nine: true, claude: true, teamviewer: true, chrome: true, termius: false },
    { name: "No Account Required", nine: true, claude: false, teamviewer: false, chrome: false, termius: false }
  ];

  const products = [
    { key: "nine", name: "9Remote", color: "emerald-500" },
    { key: "claude", name: "Claude Remote", color: "purple-500" },
    { key: "teamviewer", name: "TeamViewer", color: "blue-500" },
    { key: "chrome", name: "Chrome Remote", color: "gray-500" },
    { key: "termius", name: "Termius", color: "orange-500" }
  ];

  const CheckIcon = () => (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
    </svg>
  );

  const CrossIcon = () => (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
    </svg>
  );

  return (
    <section className="relative py-20 px-4 sm:px-6 lg:px-8 bg-white">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold mb-4">
            <span className="text-gray-900">Why Choose </span>
            <span className="bg-gradient-to-r from-brand-500 to-purple-600 bg-clip-text text-transparent">9Remote?</span>
          </h2>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            Compare features with other remote access solutions
          </p>
        </div>

        {/* Desktop Table */}
        <div className="hidden md:block overflow-x-auto">
          <div className="inline-block min-w-full align-middle">
            <div className="overflow-hidden border border-gray-200 rounded-xl shadow-lg">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-900 w-1/4">
                      Feature
                    </th>
                    {products.map((product, index) => (
                      <th
                        key={product.key}
                        className="px-3 py-3 text-center text-sm font-semibold text-gray-900"
                        style={{
                          animation: `fadeInDown 0.6s ease-out ${index * 0.1}s forwards`,
                          opacity: 0
                        }}
                      >
                        <div className={`${product.key === "nine" ? `text-${product.color} font-bold text-base` : ""}`}>
                          {product.name}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {features.map((feature, featureIndex) => (
                    <tr
                      key={feature.name}
                      className="hover:bg-gray-50 transition-colors"
                      style={{
                        animation: `fadeInUp 0.6s ease-out ${featureIndex * 0.05}s forwards`,
                        opacity: 0
                      }}
                    >
                      <td className="px-4 py-3 text-sm text-gray-900 font-medium">
                        {feature.name}
                      </td>
                      {products.map((product) => (
                        <td key={product.key} className="px-3 py-3 text-center">
                          {feature[product.key] ? (
                            <div className="inline-flex text-emerald-500">
                              <CheckIcon />
                            </div>
                          ) : (
                            <div className="inline-flex text-red-500">
                              <CrossIcon />
                            </div>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Mobile Table - Horizontal Scroll */}
        <div className="md:hidden">
          <div className="overflow-x-auto -mx-4 px-4">
            <div className="inline-block min-w-full align-middle">
              <div className="overflow-hidden border border-gray-200 rounded-xl shadow-lg">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="sticky left-0 z-10 bg-gray-50 px-4 py-3 text-left text-xs font-semibold text-gray-900 min-w-[140px]">
                        Feature
                      </th>
                      {products.map((product) => (
                        <th
                          key={product.key}
                          className="px-4 py-3 text-center text-xs font-semibold text-gray-900 min-w-[100px]"
                        >
                          <div className={`${product.key === "nine" ? `text-${product.color} font-bold` : ""}`}>
                            {product.name}
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {features.map((feature) => (
                      <tr key={feature.name} className="hover:bg-gray-50 transition-colors">
                        <td className="sticky left-0 z-10 bg-white px-4 py-3 text-xs text-gray-900 font-medium min-w-[140px]">
                          {feature.name}
                        </td>
                        {products.map((product) => (
                          <td key={product.key} className="px-4 py-3 text-center min-w-[100px]">
                            {feature[product.key] ? (
                              <div className="inline-flex text-emerald-500">
                                <CheckIcon />
                              </div>
                            ) : (
                              <div className="inline-flex text-red-500">
                                <CrossIcon />
                              </div>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          
          {/* Scroll Indicator */}
          <div className="flex items-center justify-center gap-2 mt-4 text-xs text-gray-500">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16l-4-4m0 0l4-4m-4 4h18" />
            </svg>
            <span>Swipe to compare</span>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
            </svg>
          </div>
        </div>

        {/* Summary */}
        <div className="mt-12 text-center">
          <div className="inline-flex items-center gap-2 px-6 py-3 bg-emerald-500/10 rounded-full border border-emerald-500/30">
            <svg className="w-5 h-5 text-emerald-500" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            <span className="text-emerald-500 font-semibold">9Remote: All-in-one solution with 16/16 features</span>
          </div>
        </div>
      </div>

      {/* CSS for animations */}
      <style jsx>{`
        @keyframes fadeInUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes fadeInDown {
          from {
            opacity: 0;
            transform: translateY(-20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </section>
  );
}
