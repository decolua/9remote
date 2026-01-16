import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { io } from "socket.io-client";
import { useSessionStorage } from "./useSessionStorage";

// Socket.io connection management hook
export function useSocket() {
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [sessions, setSessions] = useState([]);
  const socketRef = useRef(null);
  const router = useRouter();
  const { getAuth } = useSessionStorage();

  // Initialize socket connection
  useEffect(() => {
    const auth = getAuth();
    
    if (!auth?.tunnelUrl) {
      router.push("/");
      return;
    }

    // Create socket connection
    const newSocket = io(auth.tunnelUrl, {
      path: "/socket.io",
      transports: ["polling", "websocket"]
    });

    newSocket.on("connect", () => {
      console.log("Socket connected");
      setConnected(true);
    });

    newSocket.on("disconnect", () => {
      console.log("Socket disconnected");
      setConnected(false);
    });

    newSocket.on("sessionClosed", (sessionId) => {
      setSessions(prev => prev.filter(s => s.id !== sessionId));
    });

    socketRef.current = newSocket;
    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
  }, [router, getAuth]);

  // Load sessions list
  const loadSessions = useCallback(() => {
    if (!socketRef.current) return;
    
    socketRef.current.emit("getSessions", (list) => {
      setSessions(list);
    });
  }, []);

  // Create new session
  const createSession = useCallback((name, callback) => {
    if (!socketRef.current) return;

    socketRef.current.emit("createSession", { name }, (result) => {
      if (result.success) {
        loadSessions();
      }
      callback?.(result);
    });
  }, [loadSessions]);

  // Delete session
  const deleteSession = useCallback((sessionId, callback) => {
    if (!socketRef.current) return;

    socketRef.current.emit("deleteSession", sessionId, (result) => {
      if (result.success) {
        loadSessions();
      }
      callback?.(result);
    });
  }, [loadSessions]);

  return {
    socket: socketRef.current,
    connected,
    sessions,
    loadSessions,
    createSession,
    deleteSession
  };
}
