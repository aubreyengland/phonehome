export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type NavKey = 'fleet' | 'console' | 'zoom' | 'profiles' | 'settings';

const NAV: { key: NavKey; href: string; label: string }[] = [
  { key: 'fleet', href: '/admin', label: 'Fleet' },
  { key: 'console', href: '/admin/console', label: 'Console' },
  { key: 'zoom', href: '/admin/zoom', label: 'Zoom' },
  { key: 'profiles', href: '/admin/profiles', label: 'Profiles' },
  { key: 'settings', href: '/admin/settings', label: 'Settings' },
];

const CSS = `
  body { font: 14px/1.4 system-ui, sans-serif; margin: 0; color: #1a1a1a; }
  nav { display: flex; gap: 1rem; padding: .75rem 1.5rem; background: #f5f5f5; border-bottom: 1px solid #ddd; }
  nav a { text-decoration: none; color: #333; }
  nav a.active { font-weight: 700; border-bottom: 2px solid #333; }
  main { padding: 1.5rem; }
  h1, h2 { font-weight: 600; }
  .summary { display: flex; gap: 1.5rem; margin: 1rem 0; flex-wrap: wrap; }
  .summary div { padding: .5rem .75rem; border: 1px solid #ddd; border-radius: 6px; }
  .summary strong { display: block; font-size: 1.4rem; }
  .filters a { margin-right: .75rem; }
  .filters a.active { font-weight: 700; text-decoration: none; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #e5e5e5; white-space: nowrap; }
  th { background: #f5f5f5; position: sticky; top: 0; }
  .mono { font-family: ui-monospace, monospace; }
  .num { text-align: right; }
  .muted { color: #999; }
  .badge { font-size: .75rem; padding: .1rem .4rem; border-radius: 4px; background: #eee; }
  .status-seen .badge, .kind-redirect .badge, .on { background: #d8f3dc; }
  .status-not-seen .badge, .kind-accepted .badge { background: #fff3cd; }
  .status-unexpected .badge, .kind-not_found .badge, .off { background: #f8d7da; }
  form label { display: block; margin: .5rem 0; }
  form input[type=text], form input[type=password], form input[type=url] { width: 28rem; max-width: 100%; }
  button { cursor: pointer; }
  pre { background: #f5f5f5; padding: .5rem; overflow: auto; white-space: pre-wrap; }
`;

export function renderPage(title: string, active: NavKey, body: string, extraHead = ''): string {
  const nav = NAV.map((n) => `<a href="${n.href}"${n.key === active ? ' class="active"' : ''}>${n.label}</a>`).join('\n    ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
${extraHead}
</head>
<body>
  <nav>
    ${nav}
  </nav>
  <main>
${body}
  </main>
</body>
</html>`;
}
