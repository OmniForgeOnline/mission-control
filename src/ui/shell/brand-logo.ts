import logoSvg from "../public/omniforge-horizontal-transparent.svg?raw";

/** Inline OmniForge horizontal wordmark (mark + name). Text follows CSS `color`. */
export function brandLogoHtml(): string {
  return logoSvg.trim();
}
