/** Vite client asset modules used by the UI bundle. */
declare module "*.css";
declare module "*.svg?raw" {
  const src: string;
  export default src;
}
