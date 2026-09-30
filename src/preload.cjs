const { contextBridge, ipcRenderer } = require("electron");
const allowed = [
  "init",
  "choose",
  "start",
  "stop",
  "answer",
  "config",
  "saveConfig",
  "logs",
  "login",
  "connect",
  "resume",
  "demo",
  "scan",
  "security",
  "scanStop",
  "brief",
  "exportReport",
  "web",
];
contextBridge.exposeInMainWorld("pilot", {
  call: (name, arg) => {
    if (!allowed.includes(name)) throw Error("Unsupported action");
    return ipcRenderer.invoke(name, arg);
  },
  on: (name, fn) => {
    if (!["task", "approval", "idle", "audit"].includes(name))
      throw Error("Unsupported event");
    ipcRenderer.on(name, (_e, data) => fn(data));
  },
});
