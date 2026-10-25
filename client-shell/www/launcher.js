const server = document.getElementById("server");
server.value = localStorage.getItem("aremote.server") || "";
document.getElementById("connect").onsubmit = e => {
  e.preventDefault();
  try {
    const url = new URL(server.value);
    const port = document.getElementById("port").value;
    if (port) url.port = port;
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("请输入 HTTPS Server 地址，例如 https://remote.example.com:8443");
    localStorage.setItem("aremote.server", url.origin);
    location.href = url.origin + "/login";
  } catch (err) { document.getElementById("error").textContent = err.message; }
};
