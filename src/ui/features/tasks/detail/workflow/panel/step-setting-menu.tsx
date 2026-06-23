import { useEffect, useRef, useState } from "preact/hooks";
import type { VNode } from "preact";

export interface StepSettingOption {
  /** Stable value passed to onSelect. "" denotes the default/inherit option. */
  value: string;
  label: string;
  /** Leading visual (swatch or effort bars). */
  leading: VNode;
  /** Optional right-aligned hint (e.g. the resolved default name). */
  meta?: string | undefined;
}

const CHECK = (
  <svg class="wf-setting-check" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.4" />
  </svg>
);

/**
 * A small popover dropdown used by the step-scoped Agent and Effort controls.
 * Renders a chip trigger (leading visual + label + chevron) and a popover menu
 * of options with per-option leading visuals and a check on the selected one.
 * Closes on outside-click, Escape, or selection.
 */
export function StepSettingMenu({
  label,
  heading,
  options,
  selected,
  triggerLeading,
  triggerLabel,
  disabled = false,
  onSelect
}: {
  label: string;
  heading: string;
  options: StepSettingOption[];
  selected: string;
  triggerLeading: VNode;
  triggerLabel: string;
  disabled?: boolean;
  onSelect: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (value: string) => {
    setOpen(false);
    if (value !== selected) onSelect(value);
  };

  return (
    <div class="wf-setting" ref={ref}>
      <button
        type="button"
        class="wf-setting-field"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {triggerLeading}
        <span class="wf-setting-value">{triggerLabel}</span>
        <span class="wf-setting-chev" aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div class="wf-setting-menu" role="menu">
          <div class="wf-setting-mh">{heading}</div>
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="menuitemradio"
              aria-checked={opt.value === selected}
              class={`wf-setting-opt${opt.value === selected ? " is-selected" : ""}`}
              onClick={() => pick(opt.value)}
            >
              {opt.leading}
              <span class="wf-setting-opt-label">{opt.label}</span>
              {opt.meta ? <span class="wf-setting-opt-meta">{opt.meta}</span> : null}
              {CHECK}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
