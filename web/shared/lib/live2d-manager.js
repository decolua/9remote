/**
 * Live2D Model Manager
 * Manages Live2D models from multiple sources
 */

// Live2D Model Sources
export const MODEL_SOURCES = {
  EVRSTR: {
    name: "evrstr/live2d-widget-models",
    baseUrl: "https://cdn.jsdelivr.net/gh/evrstr/live2d-widget-models/live2d_evrstr",
    type: "cdn"
  },
  ICHARLESZ: {
    name: "iCharlesZ/vscode-live2d-models", 
    baseUrl: "https://raw.githubusercontent.com/iCharlesZ/vscode-live2d-models/master/model-library",
    type: "raw"
  },
  NOVA1751: {
    name: "nova1751/live2d-api",
    baseUrl: "https://nova1751.github.io/live2d-api/model",
    type: "github-pages"
  },
  LOCAL: {
    name: "Local Models",
    baseUrl: "/live2d/models",
    type: "local"
  }
};

// Comprehensive model list from multiple sources
export const LIVE2D_MODELS = [
  // Girls Frontline Series
  {
    id: "hk416",
    name: "HK416",
    source: MODEL_SOURCES.EVRSTR,
    path: "hk416_805",
    category: "girls-frontline",
    description: "HK416 từ Girls Frontline",
    thumbnail: "hk416.jpg"
  },
  {
    id: "ump45",
    name: "UMP45",
    source: MODEL_SOURCES.EVRSTR,
    path: "ump45_3403",
    category: "girls-frontline",
    description: "UMP45 từ Girls Frontline",
    thumbnail: "ump45.jpg"
  },
  {
    id: "ump9",
    name: "UMP9",
    source: MODEL_SOURCES.EVRSTR,
    path: "ump9_3404",
    category: "girls-frontline",
    description: "UMP9 từ Girls Frontline",
    thumbnail: "ump9.jpg"
  },
  {
    id: "wa2000",
    name: "WA2000",
    source: MODEL_SOURCES.EVRSTR,
    path: "wa2000_6",
    category: "girls-frontline",
    description: "WA2000 từ Girls Frontline",
    thumbnail: "wa2000.jpg"
  },
  
  // Anime Characters
  {
    id: "miku",
    name: "Hatsune Miku",
    source: MODEL_SOURCES.EVRSTR,
    path: "miku",
    category: "vocaloid",
    description: "Hatsune Miku Virtual Singer",
    thumbnail: "miku.jpg"
  },
  {
    id: "snow_miku",
    name: "Snow Miku",
    source: MODEL_SOURCES.EVRSTR,
    path: "snow_miku",
    category: "vocaloid",
    description: "Snow Miku phiên bản mùa đông",
    thumbnail: "snow_miku.jpg"
  },
  {
    id: "rem",
    name: "Rem",
    source: MODEL_SOURCES.EVRSTR,
    path: "rem",
    category: "anime",
    description: "Rem từ Re:Zero",
    thumbnail: "rem.jpg"
  },
  {
    id: "kurumi",
    name: "Kurumi",
    source: MODEL_SOURCES.EVRSTR,
    path: "kurumi",
    category: "anime",
    description: "Kurumi từ Date A Live",
    thumbnail: "kurumi.jpg"
  },
  
  // Cute Characters
  {
    id: "shizuku",
    name: "Shizuku",
    source: MODEL_SOURCES.EVRSTR,
    path: "shizuku",
    category: "cute",
    description: "Shizuku kawaii character",
    thumbnail: "shizuku.jpg"
  },
  {
    id: "chitose",
    name: "Chitose",
    source: MODEL_SOURCES.EVRSTR,
    path: "chitose",
    category: "cute",
    description: "Chitose cute girl",
    thumbnail: "chitose.jpg"
  },
  {
    id: "koharu",
    name: "Koharu",
    source: MODEL_SOURCES.EVRSTR,
    path: "koharu",
    category: "cute",
    description: "Koharu school girl",
    thumbnail: "koharu.jpg"
  },

  // Potion Maker Series
  {
    id: "pio",
    name: "Pio",
    source: MODEL_SOURCES.EVRSTR,
    path: "pio",
    category: "potion-maker",
    description: "Pio từ Potion Maker",
    thumbnail: "pio.jpg"
  },
  {
    id: "tia",
    name: "Tia",
    source: MODEL_SOURCES.EVRSTR,
    path: "tia",
    category: "potion-maker",
    description: "Tia từ Potion Maker",
    thumbnail: "tia.jpg"
  },

  // Special Characters
  {
    id: "epsilon",
    name: "Epsilon",
    source: MODEL_SOURCES.EVRSTR,
    path: "epsilon_2",
    category: "special",
    description: "Epsilon mysterious character",
    thumbnail: "epsilon.jpg"
  },
  {
    id: "platelet",
    name: "Platelet",
    source: MODEL_SOURCES.EVRSTR,
    path: "platelet",
    category: "anime",
    description: "Platelet từ Cells at Work",
    thumbnail: "platelet.jpg"
  },

  // Bilibili Characters  
  {
    id: "bilibili_22",
    name: "Bilibili 22",
    source: MODEL_SOURCES.EVRSTR,
    path: "22",
    category: "bilibili",
    description: "Bilibili mascot 22",
    thumbnail: "bilibili_22.jpg"
  },
  {
    id: "bilibili_33",
    name: "Bilibili 33", 
    source: MODEL_SOURCES.EVRSTR,
    path: "33",
    category: "bilibili",
    description: "Bilibili mascot 33",
    thumbnail: "bilibili_33.jpg"
  },

  // Additional popular models
  {
    id: "madoka",
    name: "Madoka",
    source: MODEL_SOURCES.EVRSTR,
    path: "madoka",
    category: "anime",
    description: "Madoka Kaname từ Madoka Magica",
    thumbnail: "madoka.jpg"
  },
  {
    id: "mikoto",
    name: "Mikoto",
    source: MODEL_SOURCES.EVRSTR,
    path: "mikoto",
    category: "anime",
    description: "Misaka Mikoto từ Toaru series",
    thumbnail: "mikoto.jpg"
  },
  {
    id: "kuroko",
    name: "Kuroko",
    source: MODEL_SOURCES.EVRSTR,
    path: "kuroko",
    category: "anime",
    description: "Shirai Kuroko từ Toaru series",
    thumbnail: "kuroko.jpg"
  }
];

/**
 * Get model URL from model config
 * @param {object} model - Model configuration
 * @returns {string} Full model URL
 */
export function getModelUrl(model) {
  const { source, path } = model;
  return `${source.baseUrl}/${path}/model.json`;
}

/**
 * Get all models by category
 * @param {string} category - Model category
 * @returns {array} Filtered models
 */
export function getModelsByCategory(category) {
  return LIVE2D_MODELS.filter(model => model.category === category);
}

/**
 * Get model by ID
 * @param {string} id - Model ID
 * @returns {object|null} Model configuration
 */
export function getModelById(id) {
  return LIVE2D_MODELS.find(model => model.id === id) || null;
}

/**
 * Get random model
 * @param {string} excludeId - Model ID to exclude
 * @returns {object} Random model
 */
export function getRandomModel(excludeId = null) {
  let availableModels = LIVE2D_MODELS;
  if (excludeId) {
    availableModels = LIVE2D_MODELS.filter(model => model.id !== excludeId);
  }
  return availableModels[Math.floor(Math.random() * availableModels.length)];
}

/**
 * Get all categories
 * @returns {array} Available categories
 */
export function getCategories() {
  const categories = [...new Set(LIVE2D_MODELS.map(model => model.category))];
  return categories.sort();
}

/**
 * Load Live2D model with proper error handling
 * @param {string} modelId - Model ID to load
 * @returns {Promise<object>} Model data or error
 */
export async function loadLive2DModel(modelId) {
  try {
    const model = getModelById(modelId);
    if (!model) {
      throw new Error(`Model ${modelId} not found`);
    }

    const modelUrl = getModelUrl(model);
    console.log(`Loading Live2D model: ${model.name} from ${modelUrl}`);

    const response = await fetch(modelUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch model: ${response.status}`);
    }

    const modelData = await response.json();
    
    return {
      success: true,
      model,
      data: modelData,
      url: modelUrl
    };
  } catch (error) {
    console.error("Error loading Live2D model:", error);
    return {
      success: false,
      error: error.message,
      model: null
    };
  }
}

/**
 * Preload multiple models for better performance
 * @param {array} modelIds - Array of model IDs to preload
 * @returns {Promise<object>} Results of preload operations
 */
export async function preloadModels(modelIds) {
  const results = {
    success: [],
    failed: []
  };

  for (const modelId of modelIds) {
    try {
      const result = await loadLive2DModel(modelId);
      if (result.success) {
        results.success.push(result);
      } else {
        results.failed.push({ modelId, error: result.error });
      }
    } catch (error) {
      results.failed.push({ modelId, error: error.message });
    }
  }

  return results;
}

// Default models to load on startup
export const DEFAULT_MODELS = ["pio", "miku", "rem", "hk416", "shizuku"];

// Model categories for UI
export const MODEL_CATEGORIES = {
  "girls-frontline": "少女前线",
  "vocaloid": "Vocaloid",
  "anime": "动漫角色", 
  "cute": "可爱角色",
  "potion-maker": "Potion Maker",
  "special": "特殊角色",
  "bilibili": "Bilibili"
};

export const DEFAULT_MODEL_ID = "pio";
