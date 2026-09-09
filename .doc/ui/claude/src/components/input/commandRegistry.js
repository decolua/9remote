// test-claude-web/src/components/input/commandRegistry.js
// Central definitions for Claude Code slash commands, skills, and submenus

export const BUILTIN_COMMANDS = [
  {
    name: "/help",
    description: "Xem trợ giúp và danh sách tính năng Claude Code",
    category: "system",
  },
  {
    name: "/clear",
    description: "Xóa sạch màn hình và làm mới ngữ cảnh",
    category: "system",
  },
  {
    name: "/compact",
    description: "Tóm tắt & nén ngữ cảnh hội thoại để tiết kiệm token",
    category: "system",
  },
  {
    name: "/cost",
    description: "Hiển thị chi phí và token đã sử dụng trong phiên",
    category: "system",
  },
  {
    name: "/model",
    description: "Đổi mô hình AI (sonnet, opus, haiku, fable...)",
    category: "settings",
    hasSubmenu: true,
    subOptions: [
      { value: "sonnet", label: "Sonnet 3.7", desc: "Cân bằng tốc độ & lập trình thông minh" },
      { value: "opus", label: "Opus", desc: "Tư duy sâu & tác vụ kiến trúc phức tạp" },
      { value: "haiku", label: "Haiku", desc: "Siêu nhanh & nhẹ cho tác vụ đơn giản" },
      { value: "fable", label: "Fable", desc: "Mô hình chuyên xử lý nhanh" },
      { value: "sonnet[1m]", label: "Sonnet [1M context]", desc: "Ngữ cảnh 1 triệu token mở rộng" },
      { value: "opus[1m]", label: "Opus [1M context]", desc: "Ngữ cảnh 1 triệu token cao cấp" },
      { value: "best", label: "Best", desc: "Mô hình tốt nhất hiện tại" },
    ],
  },
  {
    name: "/effort",
    description: "Đặt mức độ suy nghĩ/lập luận sâu (reasoning effort)",
    category: "settings",
    hasSubmenu: true,
    subOptions: [
      { value: "low", label: "low", desc: "Tốc độ nhanh, suy nghĩ ngắn" },
      { value: "medium", label: "medium", desc: "Cân bằng (Mặc định)" },
      { value: "high", label: "high", desc: "Suy nghĩ kỹ trước khi code" },
      { value: "xhigh", label: "xhigh", desc: "Lập luận rất sâu" },
      { value: "max", label: "max", desc: "Mức suy nghĩ tối đa" },
    ],
  },
  {
    name: "/config",
    description: "Xem và điều chỉnh các cờ cấu hình Claude Code",
    category: "settings",
    hasSubmenu: true,
    subOptions: [
      { value: "autoCompact=true", label: "autoCompact=true", desc: "Tự động nén ngữ cảnh khi đầy" },
      { value: "thinking=true", label: "thinking=true", desc: "Bật hiển thị khối suy nghĩ" },
      { value: "verbose=true", label: "verbose=true", desc: "Bật log chi tiết mọi tool call" },
      { value: "editor=vim", label: "editor=vim", desc: "Dùng phím tắt vim" },
      { value: "theme=dark", label: "theme=dark", desc: "Giao diện tối" },
      { value: "permissionMode=acceptEdits", label: "permissionMode=acceptEdits", desc: "Tự động duyệt sửa file" },
      { value: "permissionMode=auto", label: "permissionMode=auto", desc: "Tự động duyệt mọi thao tác" },
    ],
  },
  {
    name: "/mcp",
    description: "Quản lý các server MCP kết nối ngoài và tools",
    category: "tools",
  },
  {
    name: "/tasks",
    description: "Xem và quản lý các tác vụ ngầm / background agents",
    category: "system",
  },
  {
    name: "/resume",
    description: "Tiếp tục một phiên chat cũ trong dự án này",
    category: "session",
  },
  {
    name: "/doctor",
    description: "Kiểm tra sức khỏe hệ thống và môi trường CLI",
    category: "system",
  },
  {
    name: "/init",
    description: "Tạo hoặc cập nhật file hướng dẫn dự án CLAUDE.md",
    category: "workflow",
  },
  {
    name: "/fast",
    description: "Bật/tắt chế độ phản hồi nhanh (Fast mode)",
    category: "settings",
  },
  {
    name: "/context",
    description: "Xem thống kê phân bổ ngữ cảnh hội thoại",
    category: "system",
  },
  {
    name: "/review",
    description: "Review code diff và tìm lỗi (code-review skill)",
    category: "skill",
  },
  {
    name: "/simplify",
    description: "Đơn giản hóa và tối ưu code vừa sửa",
    category: "skill",
  },
];

// Helper to merge dynamic skills from server init
export function buildCommandList(dynamicSkills = [], dynamicSlash = []) {
  const map = new Map();
  for (const cmd of BUILTIN_COMMANDS) {
    map.set(cmd.name, cmd);
  }

  for (const skill of dynamicSkills) {
    const key = `/${skill}`;
    if (!map.has(key)) {
      map.set(key, {
        name: key,
        description: `Skill: ${skill}`,
        category: "skill",
      });
    }
  }

  for (const slash of dynamicSlash) {
    const key = `/${slash}`;
    if (!map.has(key)) {
      map.set(key, {
        name: key,
        description: `Lệnh CLI: ${slash}`,
        category: "command",
      });
    }
  }

  return Array.from(map.values());
}
