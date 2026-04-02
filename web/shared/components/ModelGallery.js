"use client";

import { useState } from "react";
import { 
  LIVE2D_MODELS, 
  MODEL_CATEGORIES, 
  getModelsByCategory, 
  getCategories 
} from "@/shared/lib/live2d-manager";

export default function ModelGallery({ onModelSelect, selectedModelId }) {
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [isOpen, setIsOpen] = useState(false);

  const categories = getCategories();
  const displayModels = selectedCategory === "all" 
    ? LIVE2D_MODELS 
    : getModelsByCategory(selectedCategory);

  const toggleGallery = () => {
    setIsOpen(!isOpen);
  };

  const handleModelSelect = (model) => {
    if (onModelSelect) {
      onModelSelect(model.id);
    }
    setIsOpen(false);
  };

  const handleCategoryChange = (category) => {
    setSelectedCategory(category);
  };

  if (!isOpen) {
    return (
      <button
        onClick={toggleGallery}
        className="fixed bottom-4 right-4 bg-blue-600 hover:bg-blue-700 text-white p-3 rounded-full shadow-lg z-50 transition-all duration-200"
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
        </svg>
      </button>
    );
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-6xl w-full max-h-[90vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div>
            <h2 className="text-2xl font-bold text-gray-800">Live2D Model Gallery</h2>
            <p className="text-gray-600 text-sm mt-1">
              Choose từ {LIVE2D_MODELS.length} models có sẵn
            </p>
          </div>
          <button
            onClick={toggleGallery}
            className="text-gray-400 hover:text-gray-600 p-2"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Category Filter */}
        <div className="p-4 border-b border-gray-100">
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => handleCategoryChange("all")}
              className={`px-3 py-1 rounded-full text-sm transition-colors ${
                selectedCategory === "all"
                  ? "bg-blue-500 text-white"
                  : "bg-gray-100 text-gray-700 hover:bg-gray-200"
              }`}
            >
              All ({LIVE2D_MODELS.length})
            </button>
            {categories.map((category) => {
              const count = getModelsByCategory(category).length;
              return (
                <button
                  key={category}
                  onClick={() => handleCategoryChange(category)}
                  className={`px-3 py-1 rounded-full text-sm transition-colors ${
                    selectedCategory === category
                      ? "bg-blue-500 text-white"
                      : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}
                >
                  {MODEL_CATEGORIES[category]} ({count})
                </button>
              );
            })}
          </div>
        </div>

        {/* Models Grid */}
        <div className="p-6 overflow-y-auto max-h-[60vh]">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {displayModels.map((model) => (
              <div
                key={model.id}
                className={`bg-white border-2 rounded-lg p-4 cursor-pointer transition-all duration-200 hover:shadow-lg hover:scale-105 ${
                  selectedModelId === model.id
                    ? "border-blue-500 bg-blue-50"
                    : "border-gray-200 hover:border-blue-300"
                }`}
                onClick={() => handleModelSelect(model)}
              >
                {/* Model Preview Image Placeholder */}
                <div className="aspect-square bg-gradient-to-br from-blue-100 to-purple-100 rounded-lg mb-3 flex items-center justify-center">
                  <div className="text-3xl">
                    {model.category === "girls-frontline" && "🔫"}
                    {model.category === "vocaloid" && "🎵"}
                    {model.category === "anime" && "✨"}
                    {model.category === "cute" && "💖"}
                    {model.category === "potion-maker" && "🧪"}
                    {model.category === "special" && "🌟"}
                    {model.category === "bilibili" && "📺"}
                    {!["girls-frontline", "vocaloid", "anime", "cute", "potion-maker", "special", "bilibili"].includes(model.category) && "🎭"}
                  </div>
                </div>

                {/* Model Info */}
                <div className="text-center">
                  <h3 className="font-semibold text-gray-800 text-sm mb-1 truncate">
                    {model.name}
                  </h3>
                  <p className="text-xs text-gray-500 mb-2">
                    {MODEL_CATEGORIES[model.category]}
                  </p>
                  <p className="text-xs text-gray-400 line-clamp-2">
                    {model.description}
                  </p>
                </div>

                {/* Current Model Indicator */}
                {selectedModelId === model.id && (
                  <div className="absolute top-2 right-2 bg-blue-500 text-white text-xs px-2 py-1 rounded-full">
                    Current
                  </div>
                )}
              </div>
            ))}
          </div>

          {displayModels.length === 0 && (
            <div className="text-center py-12">
              <div className="text-gray-400 text-4xl mb-4">🔍</div>
              <p className="text-gray-500">No models found in this category</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-100 bg-gray-50">
          <div className="flex items-center justify-between text-sm text-gray-600">
            <div>
              Showing {displayModels.length} models
              {selectedCategory !== "all" && ` in ${MODEL_CATEGORIES[selectedCategory]}`}
            </div>
            <div className="flex items-center gap-4">
              <span>Sources:</span>
              <div className="flex gap-2">
                <span className="px-2 py-1 bg-green-100 text-green-700 rounded text-xs">
                  CDN
                </span>
                <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded text-xs">
                  GitHub
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
