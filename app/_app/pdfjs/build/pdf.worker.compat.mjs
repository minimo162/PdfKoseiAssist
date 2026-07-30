function installGetOrInsertComputedPolyfill() {
  const install = proto => {
    if (!proto || typeof proto.getOrInsertComputed === "function") return;
    Object.defineProperty(proto, "getOrInsertComputed", {
      configurable: true,
      writable: true,
      value: function(key, callback) {
        if (this.has(key)) return this.get(key);
        const value = callback(key);
        this.set(key, value);
        return value;
      }
    });
  };
  install(Map.prototype);
  install(WeakMap.prototype);
}
installGetOrInsertComputedPolyfill();
await import("./pdf.worker.min.mjs");
