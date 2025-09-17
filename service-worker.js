self.addEventListener("install", () => {
  console.log("Service Worker installed");
});

self.addEventListener("fetch", (event) => {
  // can be extended for caching if you like
});
