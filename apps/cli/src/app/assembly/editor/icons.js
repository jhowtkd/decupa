// Ícones de traço (SVG inline, decorativos): o texto do controle ou o
// aria-label carrega o significado. A UI não usa emoji nem glifo unicode.
const stroke = (size, body, extra = "") => '<svg class="i' + extra + '" width="' + size + '" height="' + size
  + '" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"'
  + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + "</svg>";

export const ICON = {
  alert: stroke(14, '<circle cx="8" cy="8" r="6.5"/><path d="M8 4.8v3.8M8 11.1v.1"/>'),
  check: stroke(13, '<path d="M3 8.5l3.2 3L13 4.5"/>'),
  circle: stroke(16, '<circle cx="8" cy="8" r="6.5"/>'),
  file: stroke(18, '<path d="M4 1.5h5.5L12.5 4.5v10h-8.5z"/><path d="M9.5 1.5v3h3"/>'),
  image: stroke(11, '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M2 11l3.5-3.5L9 11l2-2 3 3"/>'),
  importMedia: '<svg class="i" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
    + ' stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 9h18M8 5v4M16 5v4M12 12v5M9.5 14.5L12 12l2.5 2.5"/></svg>',
  lock: stroke(13, '<rect x="3" y="7" width="10" height="7" rx="2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>'),
  more: '<svg class="i" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">'
    + '<circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>',
  ok: stroke(14, '<circle cx="8" cy="8" r="6.5"/><path d="M5.2 8.3l1.9 1.8 3.7-3.8"/>'),
  play: '<svg class="i" width="10" height="10" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>',
  plus: stroke(12, '<path d="M8 3v10M3 8h10"/>'),
  send: stroke(14, '<path d="M8 13V3M4 7l4-4 4 4"/>'),
  spinner: stroke(16, '<circle cx="8" cy="8" r="6.5" stroke-opacity=".25"/><path d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5"/>', " spin"),
  undo: stroke(16, '<path d="M6 3.5L3 6.5l3 3M3.5 6.5h6a3.5 3.5 0 0 1 0 7H8"/>'),
  unlock: stroke(13, '<rect x="3" y="7" width="10" height="7" rx="2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0"/>'),
};
