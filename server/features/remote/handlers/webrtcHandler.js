// WebRTC Signaling Handler for Remote Desktop

export class WebRTCHandler {
  constructor(webrtcManager) {
    this.webrtcManager = webrtcManager;
  }

  setupWebRTCHandlers(socket) {
    const { webrtcManager } = this;

    socket.on("webrtc:offer", async ({ sdp }) => {
      try {
        const { pc } = webrtcManager.createPeer(socket.id);
        pc.onLocalCandidate((candidate, mid) => {
          if (candidate) socket.emit("webrtc:ice-candidate", { candidate, mid });
        });
        const answerSdp = await webrtcManager.processOffer(socket.id, sdp);
        socket.emit("webrtc:answer", { sdp: answerSdp });
      } catch (err) {
        console.error("[WebRTC] offer error:", err.message);
        socket.emit("webrtc:error", { message: err.message });
      }
    });

    socket.on("webrtc:ice-candidate", ({ candidate, mid }) => {
      webrtcManager.addIceCandidate(socket.id, candidate, mid || "0");
    });
  }
}
