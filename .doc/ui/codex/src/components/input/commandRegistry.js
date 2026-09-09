// test-codex-web/src/components/input/commandRegistry.js
// Definitions for Codex slash commands, models, and submenus

export const BUILTIN_COMMANDS = [
  {
    name: "/model",
    description: "Chọn mô hình AI (gpt-5.6-sol, o3, o4-mini, gemini...)",
    category: "settings",
    hasSubmenu: true,
    subOptions: [
      { value: "ag/gemini-3.8-flash-high", label: "Gemini 3.8 Flash (Mặc định)", desc: "Phản hồi siêu nhanh qua 9router" },
      { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", desc: "Mô hình lập trình mạnh mẽ nhất của OpenAI" },
      { value: "o3", label: "o3 (Reasoning)", desc: "Mô hình suy luận chiều sâu" },
      { value: "o4-mini", label: "o4-mini", desc: "Nhẹ, nhanh và tiết kiệm chi phí" },
    ],
  },
  {
    name: "/effort",
    description: "Cấu hình mức độ suy luận (Reasoning effort)",
    category: "settings",
    hasSubmenu: true,
    subOptions: [
      { value: "low", label: "low", desc: "Suy luận ngắn, phản hồi nhanh" },
      { value: "medium", label: "medium", desc: "Cân bằng tiêu chuẩn (Mặc định)" },
      { value: "high", label: "high", desc: "Suy luận sâu cho bài toán phức tạp" },
    ],
  },
  {
    name: "/sandbox",
    description: "Chính sách thực thi lệnh sandbox",
    category: "security",
    hasSubmenu: true,
    subOptions: [
      { value: "workspace-write", label: "workspace-write", desc: "Cho phép sửa file trong dự án (Mặc định)" },
      { value: "read-only", label: "read-only", desc: "Chỉ đọc, không cho sửa file hoặc ghi đĩa" },
      { value: "danger-full-access", label: "danger-full-access", desc: "Quyền truy cập toàn hệ thống (Bypass sandbox)" },
    ],
  },
  {
    name: "/skills",
    description: "Mở danh mục kỹ năng Codex đã cài đặt",
    category: "workflow",
  },
  {
    name: "/mcp",
    description: "Xem và quản lý các server MCP Codex",
    category: "tools",
  },
  {
    name: "/config",
    description: "Cấu hình tham số thực thi Codex",
    category: "settings",
  },
  {
    name: "/review",
    description: "Chạy code review tự động trên repository hiện tại",
    category: "workflow",
  },
  {
    name: "/resume",
    description: "Tiếp tục một phiên làm việc Codex trước đó",
    category: "session",
  },
  {
    name: "/clear",
    description: "Bắt đầu phiên làm việc Codex hoàn toàn mới",
    category: "system",
  },
  {
    name: "/doctor",
    description: "Kiểm tra tình trạng cài đặt và cấu hình Codex",
    category: "system",
  },
];

export function buildCommandList(dynamicSkills = []) {
  const map = new Map();
  for (const cmd of BUILTIN_COMMANDS) {
    map.set(cmd.name, cmd);
  }

  for (const skill of dynamicSkills) {
    const skillName = typeof skill === "string" ? skill : skill.name;
    const skillDesc = typeof skill === "object" ? skill.description : `Codex skill: ${skillName}`;
    const key = `/${skillName}`;
    if (!map.has(key)) {
      map.set(key, {
        name: key,
        description: skillDesc || `Codex skill: ${skillName}`,
        category: "skill",
      });
    }
  }

  return Array.from(map.values());
}
