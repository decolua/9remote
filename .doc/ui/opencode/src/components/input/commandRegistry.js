// test-opencode-web/src/components/input/commandRegistry.js
// Definitions for OpenCode slash commands, models, and submenus

export const BUILTIN_COMMANDS = [
  {
    name: "/model",
    description: "Chọn mô hình OpenCode (big-pickle, nemotron, mimo...)",
    category: "settings",
    hasSubmenu: true,
    subOptions: [
      { value: "opencode/big-pickle", label: "big-pickle (Mặc định)", desc: "Mô hình lập trình đa năng của OpenCode" },
      { value: "opencode/nemotron-3.5-lightning-free", label: "nemotron-3.5-lightning", desc: "Siêu tốc độ & xử lý nhanh" },
      { value: "opencode/mimo-v2.5-free", label: "mimo-v2.5-free", desc: "Mô hình miễn phí cho tác vụ cơ bản" },
      { value: "opencode/muse-spark-1.3-contributor-free", label: "muse-spark-1.3", desc: "Mô hình phân tích thông minh" },
      { value: "opencode/ling-3.0-flash-fin-free", label: "ling-3.0-flash", desc: "Mô hình phản hồi nhanh" },
    ],
  },
  {
    name: "/variant",
    description: "Cấu hình mức độ suy luận (Reasoning effort)",
    category: "settings",
    hasSubmenu: true,
    subOptions: [
      { value: "minimal", label: "minimal", desc: "Suy luận tối thiểu, tốc độ cao nhất" },
      { value: "medium", label: "medium", desc: "Mức cân bằng mặc định" },
      { value: "high", label: "high", desc: "Suy luận sâu cho bài toán khó" },
      { value: "max", label: "max", desc: "Mức độ suy luận tối đa" },
    ],
  },
  {
    name: "/mcp",
    description: "Xem và quản lý các server MCP kết nối với OpenCode",
    category: "tools",
  },
  {
    name: "/resume",
    description: "Tiếp tục một phiên làm việc OpenCode trước đó",
    category: "session",
  },
  {
    name: "/clear",
    description: "Bắt đầu phiên làm việc OpenCode hoàn toàn mới",
    category: "system",
  },
  {
    name: "/doctor",
    description: "Kiểm tra tình trạng cài đặt và cấu hình OpenCode",
    category: "system",
  },
];

export function buildCommandList() {
  return BUILTIN_COMMANDS;
}
