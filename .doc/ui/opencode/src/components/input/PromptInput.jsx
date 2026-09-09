// test-claude-web/src/components/input/PromptInput.jsx
import React, { useState, useEffect, useRef } from "react";
import { AutocompleteMenu } from "./AutocompleteMenu.jsx";
import { BUILTIN_COMMANDS, buildCommandList } from "./commandRegistry.js";

export function PromptInput({
  isTurnRunning = false,
  onSend,
  onRunShell,
  onStop,
  availableSkills = [],
  availableSlashCommands = [],
  suggestions = [],
  onOpenModal,
}) {
  const [prompt, setPrompt] = useState("");
  const [history, setHistory] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("claude_prompt_history") || "[]");
    } catch {
      return [];
    }
  });
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [tempPrompt, setTempPrompt] = useState("");

  // Autocomplete state
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuType, setMenuType] = useState("command"); // 'command' | 'submenu' | 'file'
  const [menuItems, setMenuItems] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [currentTrigger, setCurrentTrigger] = useState(null); // { char, index, cmd }

  const textareaRef = useRef(null);
  const allCommands = buildCommandList(availableSkills, availableSlashCommands);

  // Check text on change to trigger autocomplete
  useEffect(() => {
    const text = prompt;
    const cursor = textareaRef.current ? textareaRef.current.selectionStart : text.length;
    const beforeCursor = text.slice(0, cursor);

    // 1. Check Submenu trigger (e.g. "/model " or "/effort " or "/config ")
    const matchedCmdWithSpace = allCommands.find(
      (c) => c.hasSubmenu && beforeCursor.startsWith(`${c.name} `)
    );
    if (matchedCmdWithSpace) {
      const subQuery = beforeCursor.slice(matchedCmdWithSpace.name.length + 1).toLowerCase();
      const options = (matchedCmdWithSpace.subOptions || []).filter(
        (o) => o.value.toLowerCase().includes(subQuery) || o.label.toLowerCase().includes(subQuery)
      );
      if (options.length > 0) {
        setMenuType("submenu");
        setMenuItems(options);
        setSelectedIndex(0);
        setMenuOpen(true);
        setCurrentTrigger({ char: "sub", cmd: matchedCmdWithSpace.name });
        return;
      }
    }

    // 2. Check "/" Command trigger at start
    if (beforeCursor.startsWith("/")) {
      const query = beforeCursor.slice(1).toLowerCase();
      const filtered = allCommands.filter(
        (c) => c.name.toLowerCase().includes(query) || (c.description || "").toLowerCase().includes(query)
      );
      if (filtered.length > 0) {
        setMenuType("command");
        setMenuItems(filtered);
        setSelectedIndex(0);
        setMenuOpen(true);
        setCurrentTrigger({ char: "/", index: 0 });
        return;
      }
    }

    // 3. Check "@" File trigger anywhere
    const lastAtIdx = beforeCursor.lastIndexOf("@");
    if (lastAtIdx !== -1 && (lastAtIdx === 0 || /\s/.test(beforeCursor[lastAtIdx - 1]))) {
      const fileQuery = beforeCursor.slice(lastAtIdx + 1);
      if (!fileQuery.includes(" ")) {
        // Fetch files from backend
        fetch(`/api/files?q=${encodeURIComponent(fileQuery)}`)
          .then((res) => res.json())
          .then((data) => {
            const files = data.files || [];
            if (files.length > 0) {
              setMenuType("file");
              setMenuItems(files);
              setSelectedIndex(0);
              setMenuOpen(true);
              setCurrentTrigger({ char: "@", index: lastAtIdx });
            } else {
              setMenuOpen(false);
            }
          })
          .catch(() => setMenuOpen(false));
        return;
      }
    }

    setMenuOpen(false);
  }, [prompt]);

  const executePrompt = (text) => {
    if (!text) return;
    if (isTurnRunning) {
      alert("Lượt chat trước đang chạy. Vui lòng đợi hoặc bấm 'Dừng'.");
      return;
    }

    // Save prompt history
    const nextHistory = [...history.filter((h) => h !== text), text].slice(-100);
    setHistory(nextHistory);
    try {
      localStorage.setItem("claude_prompt_history", JSON.stringify(nextHistory));
    } catch {}

    setHistoryIdx(-1);
    setPrompt("");
    if (textareaRef.current) {
      textareaRef.current.value = "";
    }
    setMenuOpen(false);

    setTimeout(() => {
      setPrompt("");
      if (textareaRef.current) {
        textareaRef.current.value = "";
      }
    }, 0);

    // Shell command prefix check "! "
    if (text.startsWith("!")) {
      const cmd = text.slice(1).trim();
      if (cmd && onRunShell) {
        onRunShell(cmd);
        return;
      }
    }

    onSend(text);
  };

  const handleSelectOption = (item, isTab = false) => {
    if (!currentTrigger || !item) return;

    if (menuType === "command") {
      if (item.name === "/model" && onOpenModal) {
        setPrompt("");
        setMenuOpen(false);
        onOpenModal("model");
        return;
      }
      if (item.name === "/config" && onOpenModal) {
        setPrompt("");
        setMenuOpen(false);
        onOpenModal("config");
        return;
      }
      if (item.name === "/mcp" && onOpenModal) {
        setPrompt("");
        setMenuOpen(false);
        onOpenModal("mcp");
        return;
      }
      if (item.name === "/skills" && onOpenModal) {
        setPrompt("");
        setMenuOpen(false);
        onOpenModal("skills");
        return;
      }
      if (item.name === "/resume" && onOpenModal) {
        setPrompt("");
        setMenuOpen(false);
        onOpenModal("resume");
        return;
      }
      if (item.name === "/tasks" && onOpenModal) {
        setPrompt("");
        setMenuOpen(false);
        onOpenModal("tasks");
        return;
      }
      if (item.name === "/doctor" && onOpenModal) {
        setPrompt("");
        setMenuOpen(false);
        onOpenModal("doctor");
        return;
      }

      // If command has submenu or was Tab -> fill prompt
      if (item.hasSubmenu || isTab) {
        setPrompt(`${item.name} `);
        setMenuOpen(false);
        if (textareaRef.current) textareaRef.current.focus();
        return;
      }

      // Enter on command without submenu -> EXECUTE IMMEDIATELY!
      executePrompt(item.name);
      return;
    }

    if (menuType === "submenu") {
      const fullCmd = `${currentTrigger.cmd} ${item.value}`;
      if (isTab) {
        setPrompt(fullCmd);
        setMenuOpen(false);
        if (textareaRef.current) textareaRef.current.focus();
        return;
      }
      // Enter on a submenu option -> EXECUTE IMMEDIATELY!
      executePrompt(fullCmd);
      return;
    }

    if (menuType === "file") {
      const filePath = typeof item === "string" ? item : (item.path || "");
      const before = prompt.slice(0, currentTrigger.index);
      const after = prompt.slice(textareaRef.current ? textareaRef.current.selectionStart : prompt.length);
      const cleanAfter = after.startsWith(" ") ? after : (after ? ` ${after}` : " ");
      setPrompt(`${before}@${filePath}${cleanAfter}`);
      setMenuOpen(false);
      if (textareaRef.current) textareaRef.current.focus();
    }
  };

  const handleKeyDown = (e) => {
    // Autocomplete navigation
    if (menuOpen && menuItems.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % menuItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + menuItems.length) % menuItems.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        handleSelectOption(menuItems[selectedIndex], true);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        handleSelectOption(menuItems[selectedIndex], false);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuOpen(false);
        return;
      }
    }

    // Prompt History Traversal (Arrow Up / Down when at first/last line)
    if (!menuOpen) {
      if (e.key === "ArrowUp") {
        const cursor = e.target.selectionStart;
        if (cursor === 0 || !prompt.includes("\n")) {
          e.preventDefault();
          if (history.length === 0) return;
          if (historyIdx === -1) {
            setTempPrompt(prompt);
            const nextIdx = history.length - 1;
            setHistoryIdx(nextIdx);
            setPrompt(history[nextIdx]);
          } else if (historyIdx > 0) {
            const nextIdx = historyIdx - 1;
            setHistoryIdx(nextIdx);
            setPrompt(history[nextIdx]);
          }
        }
      } else if (e.key === "ArrowDown") {
        const cursor = e.target.selectionStart;
        if (cursor === prompt.length || !prompt.includes("\n")) {
          if (historyIdx !== -1) {
            e.preventDefault();
            if (historyIdx < history.length - 1) {
              const nextIdx = historyIdx + 1;
              setHistoryIdx(nextIdx);
              setPrompt(history[nextIdx]);
            } else {
              setHistoryIdx(-1);
              setPrompt(tempPrompt);
            }
          }
        }
      }
    }

    // Submit on Enter
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      handleSubmit();
    }
  };

  const handleSubmit = () => {
    const text = prompt.trim();
    if (!text) return;
    executePrompt(text);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length > 0) {
      const fileNames = Array.from(e.dataTransfer.files).map((f) => `@${f.name}`).join(" ");
      setPrompt((prev) => (prev ? `${prev} ${fileNames}` : fileNames));
    }
  };

  return (
    <div className="p-4 bg-slate-900/90 border-t border-white/10 flex flex-col gap-2 relative">
      {/* Autocomplete Popup */}
      {menuOpen && (
        <AutocompleteMenu
          type={menuType}
          items={menuItems}
          selectedIndex={selectedIndex}
          onSelect={(item) => handleSelectOption(item, false)}
        />
      )}

      {/* Predicted Prompt Suggestions Bar */}
      {suggestions.length > 0 && !isTurnRunning && (
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs">
          <span className="text-slate-500 text-[11px] font-mono flex items-center gap-1">
            <span>✨</span> Gợi ý:
          </span>
          {suggestions.slice(0, 3).map((s, idx) => (
            <button
              key={idx}
              onClick={() => {
                setPrompt(s);
                if (textareaRef.current) textareaRef.current.focus();
              }}
              className="px-2.5 py-1 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 text-[11px] truncate max-w-xs transition-colors"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Main Input Box */}
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        className="flex items-end gap-2 bg-black/40 border border-white/10 rounded-xl p-2 focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500/30 transition-all"
      >
        {/* Helper quick tags */}
        <div className="flex items-center gap-1 self-center pl-1">
          <button
            type="button"
            title="Mở menu lệnh (/)"
            onClick={() => {
              setPrompt("/");
              if (textareaRef.current) textareaRef.current.focus();
            }}
            className="w-6 h-6 rounded bg-white/5 hover:bg-white/10 text-sky-400 font-mono text-xs flex items-center justify-center font-bold"
          >
            /
          </button>
          <button
            type="button"
            title="Đính kèm file (@)"
            onClick={() => {
              setPrompt((p) => p + "@");
              if (textareaRef.current) textareaRef.current.focus();
            }}
            className="w-6 h-6 rounded bg-white/5 hover:bg-white/10 text-emerald-400 font-mono text-xs flex items-center justify-center font-bold"
          >
            @
          </button>
          <button
            type="button"
            title="Chạy lệnh Shell trực tiếp (!)"
            onClick={() => {
              setPrompt("! ");
              if (textareaRef.current) textareaRef.current.focus();
            }}
            className="w-6 h-6 rounded bg-white/5 hover:bg-white/10 text-amber-400 font-mono text-xs flex items-center justify-center font-bold"
          >
            !
          </button>
        </div>

        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Gửi yêu cầu tới OpenCode... (Gõ / xem lệnh, @ đính kèm file, ! chạy bash)"
          rows={Math.min(6, Math.max(1, (prompt.match(/\n/g) || []).length + 1))}
          className="flex-1 bg-transparent border-none text-sm text-white outline-none resize-none px-2 font-sans placeholder:text-slate-500 max-h-36 leading-relaxed"
        />

        {isTurnRunning ? (
          <button
            onClick={onStop}
            className="px-4 py-1.5 rounded-lg text-xs font-semibold text-rose-300 bg-rose-500/20 border border-rose-500/40 hover:bg-rose-500/30 transition-all flex items-center gap-1.5 shadow-sm"
          >
            <span className="w-2 h-2 rounded-full bg-rose-400 animate-pulse" />
            Dừng
          </button>
        ) : (
          <button
            disabled={!prompt.trim()}
            onClick={handleSubmit}
            className="px-5 py-1.5 rounded-lg text-xs font-semibold text-white bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:hover:bg-amber-600 shadow-sm transition-all flex items-center gap-1"
          >
            <span>Gửi</span>
            <span className="text-[10px] opacity-70">↵</span>
          </button>
        )}
      </div>
    </div>
  );
}
