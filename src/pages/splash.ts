/**
 * Public landing page at `/`.
 *
 * Why this exists: a domain with nothing at its root is left **Unrated** by URL
 * categorisation services, and corporate web filters block unrated destinations outright.
 * That is exactly what stopped phones from reaching this host during the first lab test.
 * The page is therefore served *before* the provisioning IP allowlist, because rating
 * crawlers are never on it.
 *
 * Deliberately static and inert: no script, no form, no redirect, no encoded payload, and
 * no link to `/admin`. A login form or an obfuscated blob on an unrated domain invites a
 * phishing classification, which is worse than no rating at all.
 */

const CSS = `
  :root { color-scheme: light dark; --fg: #1a1a1a; --muted: #5c5c5c; --bg: #fdfdfc; --line: #e2e2df; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #ececec; --muted: #a4a4a4; --bg: #17181a; --line: #2e3033; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  main { max-width: 42rem; margin: 0 auto; padding: 3.5rem 1.25rem 4rem; }
  h1 { font-size: 1.6rem; font-weight: 600; margin: 0 0 .25rem; letter-spacing: -0.01em; }
  .host { color: var(--muted); font-size: .95rem; margin: 0 0 2rem; }
  h2 { font-size: 1rem; font-weight: 600; margin: 2rem 0 .5rem; }
  p { margin: 0 0 1rem; }
  .lead { font-size: 1.1rem; }
  footer {
    margin-top: 2.5rem; padding-top: 1.25rem; border-top: 1px solid var(--line);
    color: var(--muted); font-size: .9rem;
  }
`;

export function renderSplashPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Administrative endpoint that serves configuration files to IP desk phones on a managed corporate network. Information technology operations; no public content.">
<meta name="robots" content="index, follow">
<title>Phone Provisioning Service</title>
<style>${CSS}</style>
</head>
<body>
  <main>
    <h1>Phone Provisioning Service</h1>
    <p class="host">Information technology operations endpoint</p>

    <p class="lead">This host serves configuration files to IP desk phones on a managed
    corporate network. It is an internal IT administration service, not a public website.</p>

    <h2>What this host does</h2>
    <p>Desk phones on the corporate network are pointed here by their network configuration.
    When a phone checks in, this service returns a small text file telling that phone which
    telephony provider to use. Nothing else is served, and no content is hosted for general
    browsing.</p>

    <h2>Access</h2>
    <p>Provisioning responses are restricted to known devices arriving from approved company
    networks. Requests for any other resource are declined. There is no public sign-in and no
    account of any kind associated with this host.</p>

    <h2>Note for network administrators and content raters</h2>
    <p>This domain is a legitimate business IT service used for telephony device management.
    The appropriate classification is information technology or business. If a web filter is
    blocking this host, the phones behind that filter cannot be configured, so please
    categorise it accordingly rather than leaving it unrated.</p>

    <footer>
      <p>Operated by the IT department responsible for this domain. Enquiries should be
      directed to that team through normal internal channels.</p>
    </footer>
  </main>
</body>
</html>
`;
}
