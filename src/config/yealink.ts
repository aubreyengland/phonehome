/**
 * Minimal Yealink auto-provision file: point the phone at Zoom and stop it from asking
 * DHCP/PnP again on the next boot (which would bring it straight back here).
 */
export function renderYealinkRedirect(zoomUrl: string): string {
  if (/[\r\n]/.test(zoomUrl)) {
    throw new Error('zoomUrl must be a single line');
  }
  return `#!version:1.0.0.1
static.auto_provision.server.url = ${zoomUrl}
static.auto_provision.dhcp_option.enable = 0
static.auto_provision.pnp_enable = 0
`;
}
