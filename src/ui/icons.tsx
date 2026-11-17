import type { ReactElement, SVGProps } from 'react';

/*
 * Compact inline-SVG icon set: 16 px grid, 1.5 px strokes, round joins, currentColor.
 * Solid shapes (play, pause, transport triangles, dots) use fill + stroke so their
 * corners are rounded consistently with the stroked glyphs.
 */
const F = { fill: 'currentColor' } as const;
const DOT = { fill: 'currentColor', stroke: 'none' } as const;

const ICONS = {
  play: <path {...F} d="M5 3.6v8.8a.6.6 0 0 0 .9.5l6.7-4.4a.6.6 0 0 0 0-1L5.9 3.1a.6.6 0 0 0-.9.5z" />,
  pause: (
    <>
      <rect {...F} x="4.25" y="3.5" width="2" height="9" rx=".4" />
      <rect {...F} x="9.75" y="3.5" width="2" height="9" rx=".4" />
    </>
  ),
  'step-back': (
    <>
      <path {...F} d="M10 4.5v7L5 8z" />
      <path d="M12 4v8" />
    </>
  ),
  'step-forward': (
    <>
      <path {...F} d="M6 4.5v7L11 8z" />
      <path d="M4 4v8" />
    </>
  ),
  'skip-start': (
    <>
      <path d="M3.25 4v8" />
      <path {...F} d="M8.25 5v6L5.25 8zM12.75 5v6L9.75 8z" />
    </>
  ),
  'skip-end': (
    <>
      <path d="M12.75 4v8" />
      <path {...F} d="M7.75 5v6l3-3zM3.25 5v6l3-3z" />
    </>
  ),
  'chevron-left': <path d="M10 3.5 5.5 8l4.5 4.5" />,
  'chevron-right': <path d="M6 3.5 10.5 8 6 12.5" />,
  'chevron-down': <path d="M3.5 6 8 10.5 12.5 6" />,
  'chevron-up': <path d="M3.5 10 8 5.5l4.5 4.5" />,
  plus: <path d="M8 3v10M3 8h10" />,
  minus: <path d="M3 8h10" />,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  check: <path d="M3 8.5 6.5 12 13 4.5" />,
  trash: (
    <>
      <path d="M2.5 4h11M6 4V2.5h4V4" />
      <path d="M4 4l.7 9.1a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4M6.75 6.75v4.5M9.25 6.75v4.5" />
    </>
  ),
  flag: <path d="M3.5 14V2.5M3.5 3h8.5l-2.25 3L12 9H3.5" />,
  'flag-end': <path d="M12.5 14V2.5M12.5 3H4l2.25 3L4 9h8.5" />,
  'arrow-to-end': <path d="M2.5 8h8.5M7.75 4.5 11.25 8l-3.5 3.5M13.5 3.5v9" />,
  folder: <path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.4 1.6H13a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />,
  file: <path d="M4 2h5l3.5 3.5V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM9 2v3.5h3.5" />,
  upload: <path d="M8 10.5V2.5M4.75 5.75 8 2.5l3.25 3.25M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2" />,
  download: <path d="M8 2.5v8M4.75 7.25 8 10.5l3.25-3.25M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2" />,
  history: <path d="M2.75 8a5.25 5.25 0 1 0 1.54-3.71M2.75 2.5v3h3M8 5.25V8l2 1.5" />,
  help: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M6.25 6.3a1.8 1.8 0 1 1 2.55 1.64c-.5.24-.8.6-.8 1.16v.4" />
      <circle {...DOT} cx="8" cy="11.4" r=".85" />
    </>
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M1.75 8h12.5M8 1.75c1.75 1.7 2.65 3.8 2.65 6.25S9.75 12.55 8 14.25C6.25 12.55 5.35 10.45 5.35 8S6.25 3.45 8 1.75z" />
    </>
  ),
  sort: <path d="M5 2.75v10.5M2.5 10.75 5 13.25l2.5-2.5M11 13.25V2.75M8.5 5.25 11 2.75l2.5 2.5" />,
  alert: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.75v3.75" />
      <circle {...DOT} cx="8" cy="11.1" r=".85" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.25v4" />
      <circle {...DOT} cx="8" cy="4.9" r=".85" />
    </>
  ),
  warning: (
    <>
      <path d="M7.13 2.5a1 1 0 0 1 1.74 0l5.4 9.5a1 1 0 0 1-.87 1.5H2.6a1 1 0 0 1-.87-1.5z" />
      <path d="M8 6.25v3" />
      <circle {...DOT} cx="8" cy="11.25" r=".8" />
    </>
  ),
  'zoom-in': <path d="M7 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zM10.25 10.25l3.25 3.25M5 7h4M7 5v4" />,
  'zoom-out': <path d="M7 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zM10.25 10.25l3.25 3.25M5 7h4" />,
  undo: <path d="M5.5 3 2.5 6l3 3M2.5 6h6.75a3.75 3.75 0 0 1 0 7.5H6" />,
  redo: <path d="M10.5 3l3 3-3 3M13.5 6H6.75a3.75 3.75 0 0 0 0 7.5H10" />,
  more: (
    <>
      <circle {...DOT} cx="3.5" cy="8" r="1.1" />
      <circle {...DOT} cx="8" cy="8" r="1.1" />
      <circle {...DOT} cx="12.5" cy="8" r="1.1" />
    </>
  ),
  search: <path d="M7 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zM10.25 10.25l3.25 3.25" />,
  link: (
    <path d="M6.75 9.25a2.5 2.5 0 0 0 3.54 0l2.47-2.47a2.5 2.5 0 0 0-3.54-3.54l-.85.85M9.25 6.75a2.5 2.5 0 0 0-3.54 0L3.24 9.22a2.5 2.5 0 0 0 3.54 3.54l.85-.85" />
  ),
  refresh: <path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71M13.25 2.5v3h-3" />,
  edit: <path d="M10.5 2.75l2.75 2.75L6 12.75l-3.25.5.5-3.25zM9 4.25 11.75 7" />,
  lock: (
    <>
      <rect x="3.25" y="7" width="9.5" height="6.75" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>
  ),
  keyboard: (
    <>
      <rect x="1.75" y="4" width="12.5" height="8" rx="1" />
      <path d="M4.5 6.75h.01M7 6.75h.01M9.5 6.75h.01M12 6.75h.01M5 9.5h6" />
    </>
  ),
} satisfies Record<string, ReactElement>;

export type IconName = keyof typeof ICONS;

export const ICON_NAMES = Object.keys(ICONS) as IconName[];

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  /** Rendered size in px (the drawing grid is always 16). */
  size?: number;
  /** Accessible name; when omitted the icon is decorative (aria-hidden). */
  title?: string;
}

export function Icon({ name, size = 16, title, className, ...rest }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `ui-icon ${className}` : 'ui-icon'}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {ICONS[name]}
    </svg>
  );
}
