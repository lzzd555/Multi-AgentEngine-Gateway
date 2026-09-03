// api.z.ai 当前 CDN 丢弃携带 MLKEM768 大 ClientHello 的 TLS 握手（Node 24 / OpenSSL 3.5 默认发送）。
// 经 NODE_OPTIONS=--require 注入 Node 子进程，限定经典曲线组恢复握手；对其他目标无害。
const tls = require("node:tls")
const originalConnect = tls.connect
tls.connect = function (...args) {
  for (const candidate of args) {
    if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate) && candidate.port != null) {
      if (candidate.ecdhCurve === undefined) candidate.ecdhCurve = "X25519:P-256:P-384"
      break
    }
  }
  return originalConnect.apply(this, args)
}
