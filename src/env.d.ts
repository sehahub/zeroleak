/// <reference types="astro/client" />

// Vite resolves a ?url import to the emitted asset's path. tsc has no idea, so
// it needs telling — and without this the browser typecheck cannot run at all.
declare module '*?url' {
  const src: string;
  export default src;
}
